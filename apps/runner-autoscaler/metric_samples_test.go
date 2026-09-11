package main

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net/http/httptest"
	"testing"
	"time"
)

func TestParseMetricValue(t *testing.T) {
	tests := []struct {
		name string
		line string
		want float64
		ok   bool
	}{
		{"plain", `node_load1 2.5`, 2.5, true},
		{"timestamp", `node_load1 2.5 1789123456000`, 2.5, true},
		{"timestamped zero", `host_ready{host="pike"} 0 1789123456000`, 0, true},
		{"spaces and escapes", `m{note="a b, } \"quoted\" \\ path\nnext",host="pike"} -1.25e2 1789123456000`, -125, true},
		{"whitespace", "m{ host = \"pike\" }\t+1.5e-2\t1789123456000", .015, true},
		{"empty labels", `m{} 3`, 3, true},
		{"trailing whitespace", "m 3 \t", 3, true},
		{"timestamp with trailing whitespace", "m 3 1789123456000 \t", 3, true},
		{"multiple lines", "m 1\nm 2", 0, false},
		{"missing value", `m`, 0, false},
		{"missing labeled value", `m{note="a 1"}`, 0, false},
		{"comment", `# HELP m 1`, 0, false},
		{"bad value with timestamp", `m invalid 1789123456000`, 0, false},
		{"bad timestamp", `m 1 invalid`, 0, false},
		{"fractional timestamp", `m 1 123.5`, 0, false},
		{"extra field", `m 1 1789123456000 2`, 0, false},
		{"unclosed labels", `m{host="pike" 1`, 0, false},
		{"unquoted label", `m{host=pike} 1`, 0, false},
		{"bad escape", `m{host="pi\qke"} 1`, 0, false},
		{"duplicate label", `m{host="pike",host="other"} 1`, 0, false},
		{"NaN", `m NaN 1789123456000`, 0, false},
		{"positive infinity", `m +Inf 1789123456000`, 0, false},
		{"negative infinity", `m -Inf`, 0, false},
		{"overflow", `m 1e999 1789123456000`, 0, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := parseMetricValue(tt.line)
			if ok != tt.ok || got != tt.want {
				t.Fatalf("parseMetricValue(%q) = (%v, %v), want (%v, %v)", tt.line, got, ok, tt.want, tt.ok)
			}
		})
	}
}

// These are HTTP probes through the actual placement gates, not just numeric
// parsing: zero, corrupt, and non-finite exporter signals must withhold a host.
func TestPlacementGateSampleValues(t *testing.T) {
	for _, gate := range []string{"mains", "readiness"} {
		for _, suffix := range []string{"", " 1789123456000"} {
			for _, value := range []string{"0", "1", "-1", "NaN", "+Inf", "-Inf", "1e999", "invalid"} {
				t.Run(gate+"/"+value+suffix, func(t *testing.T) {
					line := `node_power_supply_online{power_supply="AC",note="wall power, \"AC\" \\ cable"} ` + value + suffix
					if gate == "readiness" {
						line = `host_ready{note="a b, \"quoted\" \\ path",host="pike"} ` + value + suffix
					}
					server := httptest.NewServer(servePlain(line + "\n"))
					t.Cleanup(server.Close)
					scaler := &Scaler{hostMetricsURLTemplate: server.URL + "/%s", readinessMetricsURL: server.URL, readinessMetric: "host_ready"}
					var err error
					if gate == "mains" {
						err = scaler.hostOnMains(context.Background(), "pike")
					} else {
						err = scaler.hostReady(context.Background(), "pike")
					}
					if allowed := err == nil; allowed != (value == "1") {
						t.Fatalf("placement allowed = %v for %q (error: %v)", allowed, line, err)
					}
				})
			}
		}
	}
}

func TestPlacementGatesRejectMalformedSamples(t *testing.T) {
	for _, sample := range []string{
		`{host=pike,power_supply="AC"} 1`,
		`{host="pike",power_supply="AC" 1`,
		`{host="pike",power_supply="AC",note="bad\q"} 1`,
		`{host="pike",host="other",power_supply="AC"} 1`,
		`{host="pike",power_supply="AC"} 1 invalid`,
		`{host="pike",power_supply="AC"} 1 1789123456000 extra`,
	} {
		t.Run(sample, func(t *testing.T) {
			server := httptest.NewServer(servePlain("node_power_supply_online" + sample + "\nhost_ready" + sample + "\n"))
			t.Cleanup(server.Close)
			scaler := &Scaler{hostMetricsURLTemplate: server.URL + "/%s", readinessMetricsURL: server.URL, readinessMetric: "host_ready"}
			if err := scaler.hostOnMains(context.Background(), "pike"); err == nil {
				t.Fatal("malformed mains signal authorized placement")
			}
			if err := scaler.hostReady(context.Background(), "pike"); err == nil {
				t.Fatal("malformed readiness signal authorized placement")
			}
		})
	}
}

func TestHostReadyTimestampedFreshness(t *testing.T) {
	for _, tt := range []struct {
		name  string
		stamp string
		ready bool
	}{
		{"fresh", fmt.Sprint(time.Now().Unix()), true},
		{"stale", fmt.Sprint(time.Now().Add(-time.Hour).Unix()), false},
		{"NaN", "NaN", false},
		{"infinite", "+Inf", false},
		{"malformed", "invalid", false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			body := "host_ready{host=\"pike\"} 1 1789123456000\nhost_ready_timestamp_seconds " + tt.stamp + " 1789123456000\n"
			server := httptest.NewServer(servePlain(body))
			t.Cleanup(server.Close)
			scaler := &Scaler{readinessMetricsURL: server.URL, readinessMetric: "host_ready", readinessMaxAge: 5 * time.Minute}
			if err := scaler.hostReady(context.Background(), "pike"); (err == nil) != tt.ready {
				t.Fatalf("hostReady() = %v, want ready=%v", err, tt.ready)
			}
		})
	}
}

func TestInferenceSampleValues(t *testing.T) {
	for _, metric := range []string{"vllm:num_requests_running", "vllm:num_requests_waiting", "llamaswap_gpu_power_draw_watts"} {
		for _, suffix := range []string{"", " 1789123456000"} {
			for _, tt := range []struct {
				value string
				busy  bool
			}{{"0", false}, {"87.5", true}} {
				t.Run(metric+"/"+tt.value+suffix, func(t *testing.T) {
					body := metric + `{model="some model",name="NVIDIA GB10 \"GPU\""} ` + tt.value + suffix + "\n"
					server := httptest.NewServer(servePlain(body))
					t.Cleanup(server.Close)
					scaler := &Scaler{inferenceMetricsURLs: map[string]string{"spark": server.URL}, logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
					if got := scaler.isHostInferenceLoaded(context.Background(), "spark"); got != tt.busy {
						t.Fatalf("isHostInferenceLoaded() = %v for %q, want %v", got, body, tt.busy)
					}
				})
			}
		}
	}
}

func TestHostLoadSampleValues(t *testing.T) {
	for _, suffix := range []string{"", " 1789123456000"} {
		t.Run("timestamp="+suffix, func(t *testing.T) {
			body := ""
			for _, line := range []string{
				"node_load1 4",
				`node_cpu_seconds_total{cpu="0",mode="idle",note="CPU zero"} 100`,
				`node_cpu_seconds_total{cpu="1",mode="idle"} 200`,
				`node_cpu_seconds_total{cpu="0",mode="user"} 900`,
				"node_memory_MemAvailable_bytes 4000000000",
				"node_memory_MemTotal_bytes 16000000000",
				"node_pressure_cpu_waiting_seconds_total 3",
				"node_pressure_memory_waiting_seconds_total 4",
				"node_vmstat_pswpin 10",
				"node_vmstat_pswpout 20",
			} {
				body += line + suffix + "\n"
			}
			server := httptest.NewServer(servePlain(body))
			t.Cleanup(server.Close)
			scaler := &Scaler{hostMetricsURLTemplate: server.URL + "/%s"}
			previous := hostSample{at: time.Now().Add(-30 * time.Second), idleSeconds: 270, cpuPressure: 2, memoryPressure: 2, swapPages: 15}
			scaler.coordinator().hostSamples = map[string]hostSample{"pike": previous}
			load, err := scaler.probeHostLoad(context.Background(), "pike", false)
			if err != nil {
				t.Fatal(err)
			}
			if load.normalizedLoad != 2 || load.memoryAvailable != .25 || load.memoryAvailableBytes != 4e9 {
				t.Fatalf("incorrect load or memory: %+v", load)
			}
			elapsed := load.observedAt.Sub(previous.at).Seconds()
			if !load.cpuUtilizationKnown || math.Abs(load.cpuUtilization-(1-30/(2*elapsed))) > 1e-9 ||
				math.Abs(load.cpuPressure-1/elapsed) > 1e-9 || math.Abs(load.memoryPressure-2/elapsed) > 1e-9 ||
				math.Abs(load.swapPagesPerSec-15/elapsed) > 1e-9 {
				t.Fatalf("incorrect counter rates: %+v", load)
			}
		})
	}
}
