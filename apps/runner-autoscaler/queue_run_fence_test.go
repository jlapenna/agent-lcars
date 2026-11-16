package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestQueueRunFenceUsesOriginalCredentialAndIdentity(t *testing.T) {
	runID := "jlapenna/agent-lcars#2209/r1"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.EscapedPath() != "/api/work/v1/runs/jlapenna%2Fagent-lcars%232209%2Fr1/brief" || r.Header.Get("Authorization") != "Bearer private-token" {
			t.Error("incorrect run fence request")
		}
		_, _ = io.WriteString(w, `{"intentId":"jlapenna/agent-lcars#2209/r1","work":{"description":"safe brief"}}`)
	}))
	defer server.Close()
	if err := queueRunFence(server.URL+"/")(context.Background(), runID, "private-token"); err != nil {
		t.Fatal(err)
	}
}

func TestQueueRunFenceAcceptsValidLargeMultibyteBrief(t *testing.T) {
	// Native briefs repeat a maximal description (the 256 KiB Work payload
	// budget less 8 KiB) in spec and anchor, plus a maximal reply and
	// context (120 KiB each) of multibyte text.
	description := strings.Repeat("界", (262144-8192-2)/3)
	param := strings.Repeat("界", (122880-2)/3)
	body, err := json.Marshal(map[string]any{
		"intentId": "work:startup/r1",
		"spec":     map[string]string{"description": description},
		"anchor":   map[string]string{"body": description},
		"reply":    param,
		"context":  param,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(body) < 750_000 {
		t.Fatalf("fixture is not a maximal brief: %d bytes", len(body))
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write(body) }))
	defer server.Close()
	if err := queueRunFence(server.URL)(context.Background(), "work:startup/r1", "private-token"); err != nil {
		t.Fatal("valid brief rejected:", err)
	}
}

func TestQueueRunFenceFailsClosedWithoutLeakingCredentials(t *testing.T) {
	for _, failure := range []string{"expired", "settled", "unavailable", "wrong identity", "malformed", "oversized", "redirect", "canceled"} {
		t.Run(failure, func(t *testing.T) {
			forwarded := false
			target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				forwarded = true
				_, _ = io.WriteString(w, `{"intentId":"work:startup/r1"}`)
			}))
			defer target.Close()
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch failure {
				case "expired":
					w.WriteHeader(http.StatusUnauthorized)
				case "settled":
					w.WriteHeader(http.StatusConflict)
				case "unavailable":
					w.WriteHeader(http.StatusServiceUnavailable)
				case "wrong identity":
					_, _ = io.WriteString(w, `{"intentId":"work:other/r1","description":"private-token"}`)
				case "malformed":
					_, _ = io.WriteString(w, "private-token")
				case "oversized":
					_, _ = io.WriteString(w, strings.Repeat("x", queueRunBriefBodyLimit+1))
				case "redirect":
					http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
				}
			}))
			defer server.Close()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if failure == "canceled" {
				cancel()
			}
			err := queueRunFence(server.URL)(ctx, "work:startup/r1", "private-token")
			if err == nil || strings.Contains(err.Error(), "private-token") || strings.Contains(err.Error(), server.URL) {
				t.Fatalf("unsafe fence error: %v", err)
			}
			if forwarded {
				t.Fatal("forwarded run credential on redirect")
			}
		})
	}
}
