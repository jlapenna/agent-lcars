package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Receipt mode is a separately approved migration, never inferred from replica
// count or local inventory. Identity and limits must match the server grant.
type queueCapacityConfig struct {
	PoolID         string `yaml:"pool_id"`
	Cluster        string `yaml:"cluster"`
	Version        int    `yaml:"version"`
	WorkerAudience string `yaml:"worker_audience"`
}

func (c *queueCapacityConfig) validate() error {
	if c == nil {
		return nil
	}
	for _, v := range []string{c.PoolID, c.Cluster, c.WorkerAudience} {
		if strings.TrimSpace(v) != v || v == "" || len(v) > 175 || strings.ContainsAny(v, "\r\n") {
			return fmt.Errorf("capacity identity must be nonempty, bounded and single-line")
		}
	}
	if c.Version < 1 {
		return fmt.Errorf("capacity version must be positive")
	}
	return nil
}

type capacityFence struct {
	PoolID   string `json:"poolId"`
	Slot     int    `json:"slot"`
	Revision int    `json:"revision"`
	RunID    string `json:"runId"`
	Nonce    string `json:"nonce"`
}

func (f capacityFence) valid(pool, run string) bool {
	return len(run) > 0 && len(run) <= 175 && f.PoolID == pool && f.RunID == run && f.Slot >= 0 && f.Revision > 0 && len(f.Nonce) >= 16 && len(f.Nonce) <= 128
}

type capacityProducer struct {
	ProducerID    string   `json:"producerId"`
	Subject       string   `json:"subject"`
	Stopped       bool     `json:"stopped"`
	Fenced        bool     `json:"fenced"`
	PendingWrites []string `json:"pendingWrites"`
}
type capacityWorker struct {
	Generation int    `json:"generation"`
	PodUID     string `json:"podUid"`
	JobUID     string `json:"jobUid"`
	Active     bool   `json:"active"`
}
type capacityReceipt struct {
	capacityFence
	JobName   string             `json:"jobName"`
	JobUID    string             `json:"jobUid"`
	SecretUID string             `json:"secretUid"`
	Pipeline  string             `json:"pipeline"`
	Runner    string             `json:"runner"`
	State     string             `json:"state"`
	Worker    *capacityWorker    `json:"worker"`
	Producers []capacityProducer `json:"producers"`
}
type capacityInventory struct {
	Policy *struct {
		PoolID         string `json:"poolId"`
		Cluster        string `json:"cluster"`
		Namespace      string `json:"namespace"`
		Version        int    `json:"version"`
		MaxConcurrent  int    `json:"maxConcurrent"`
		Enforced       bool   `json:"enforced"`
		InventoryKnown bool   `json:"inventoryKnown"`
	} `json:"policy"`
	Receipts []capacityReceipt `json:"receipts"`
}
type capacityRetirement struct {
	RunID         string `json:"runId"`
	Nonce         string `json:"nonce"`
	JobName       string `json:"jobName"`
	Released      bool   `json:"released"`
	RetainBarrier bool   `json:"retainBarrier"`
	Barrier       *struct {
		UID             string `json:"uid"`
		ResourceVersion string `json:"resourceVersion"`
	} `json:"barrier"`
}
type capacityReply struct {
	Retirement    *capacityRetirement `json:"retirement"`
	OK            bool                `json:"ok"`
	Receipt       *capacityFence      `json:"receipt"`
	Released      bool                `json:"released"`
	RetainBarrier bool                `json:"retainBarrier"`
}
type capacityClaimReply struct {
	Kind      string         `json:"kind"`
	Reason    string         `json:"reason"`
	Receipt   *capacityFence `json:"receipt"`
	RunID     string         `json:"runId"`
	JobName   string         `json:"jobName"`
	JobUID    string         `json:"jobUid"`
	SecretUID string         `json:"secretUid"`
	Pipeline  string         `json:"pipeline"`
	Token     string         `json:"token"`
}

// An unresolved request ID survives every transport/decode/HTTP failure in this
// incarnation. A successor inventories receipts instead of reviving its ID.
type queueCapacityClient struct {
	config        queueCapacityConfig
	namespace     string
	maxConcurrent int
	consoleURL    string
	idToken       func() (string, error)
	httpClient    *http.Client
	producerID    string
	available     func(bool)
	mu            sync.Mutex
	pollMu        sync.Mutex
	registered    bool
	requestID     string
}

func newCapacityIdentity() string {
	var b [24]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic("capacity identity entropy unavailable")
	}
	return hex.EncodeToString(b[:])
}
func (c *queueCapacityClient) call(ctx context.Context, method, path string, input, output any) error {
	token, err := c.idToken()
	if err != nil {
		return fmt.Errorf("capacity credential unavailable")
	}
	var body io.Reader
	if input != nil {
		b, e := json.Marshal(input)
		if e != nil {
			return fmt.Errorf("capacity request invalid")
		}
		body = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(c.consoleURL, "/")+"/api/work/v1/runs"+path, body)
	if err != nil {
		return fmt.Errorf("capacity request invalid")
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	client := c.httpClient
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("capacity request unavailable")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("capacity returned HTTP %d", resp.StatusCode)
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, (1<<20)+1))
	if err != nil || len(b) > 1<<20 {
		return fmt.Errorf("capacity response unavailable")
	}
	if json.Unmarshal(b, output) != nil {
		return fmt.Errorf("capacity response invalid")
	}
	return nil
}
func (c *queueCapacityClient) inventory(ctx context.Context) (capacityInventory, error) {
	healthy := false
	defer func() {
		if c.available != nil {
			c.available(healthy)
		}
	}()
	var x capacityInventory
	err := c.call(ctx, http.MethodGet, "/capacity", nil, &x)
	if err != nil {
		return x, err
	}
	p := x.Policy
	if p == nil || p.PoolID != c.config.PoolID || p.Cluster != c.config.Cluster || p.Namespace != c.namespace || p.Version != c.config.Version || p.MaxConcurrent != c.maxConcurrent || !p.Enforced || !p.InventoryKnown || x.Receipts == nil || len(x.Receipts) > 128 {
		return x, fmt.Errorf("capacity policy or inventory mismatch")
	}
	names := map[string]bool{}
	slots := map[int]bool{}
	for _, r := range x.Receipts {
		if !r.capacityFence.valid(c.config.PoolID, r.RunID) || r.JobName != queueJobName(r.RunID) || names[r.RunID] || slots[r.Slot] {
			return x, fmt.Errorf("capacity receipt inventory mismatch")
		}
		names[r.RunID] = true
		slots[r.Slot] = true
	}
	healthy = true
	return x, nil
}
func (c *queueCapacityClient) command(ctx context.Context, input map[string]any) (capacityReply, error) {
	var x capacityReply
	err := c.call(ctx, http.MethodPost, "/capacity", input, &x)
	if err == nil && !x.OK {
		err = fmt.Errorf("capacity command refused")
	}
	return x, err
}
func (c *queueCapacityClient) recovery(ctx context.Context, r capacityReceipt, purpose string) (string, error) {
	n := newCapacityIdentity()
	_, err := c.command(ctx, map[string]any{"action": "recover", "fence": r.capacityFence, "recoveryNonce": n, "purpose": purpose})
	return n, err
}
func (c *queueCapacityClient) operation(ctx context.Context, r capacityReceipt, n, id string, resolved bool) error {
	_, err := c.command(ctx, map[string]any{"action": "operation", "fence": r.capacityFence, "recoveryNonce": n, "producerId": c.producerID, "operationId": id, "resolved": resolved})
	return err
}

// Record before sending the Kubernetes write. Timeout, EOF, 5xx or process
// cancellation retains storage debt: a subsequent GET does not drain that RPC.
func (c *queueCapacityClient) write(ctx context.Context, r capacityReceipt, n string, write func() error) error {
	id := newCapacityIdentity()
	if err := c.operation(ctx, r, n, id, false); err != nil {
		return err
	}
	err := write()
	if err != nil && !capacityDefinitiveKubernetesError(err) {
		return err
	}
	if e := c.operation(ctx, r, n, id, true); e != nil {
		return e
	}
	return err
}
func (c *queueCapacityClient) ensureRegistered(ctx context.Context) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.registered {
		return nil
	}
	if _, err := c.inventory(ctx); err != nil {
		return err
	}
	if _, err := c.command(ctx, map[string]any{"action": "register", "producerId": c.producerID}); err != nil {
		return err
	}
	c.registered = true
	return nil
}
func (c *queueCapacityClient) claim(ctx context.Context, runner string) (capacityClaimReply, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	var x capacityClaimReply
	if _, err := c.inventory(ctx); err != nil {
		return x, err
	}
	if !c.registered {
		if _, err := c.command(ctx, map[string]any{"action": "register", "producerId": c.producerID}); err != nil {
			return x, err
		}
		c.registered = true
	}
	if c.requestID == "" {
		c.requestID = newCapacityIdentity()
	}
	if err := c.call(ctx, http.MethodPost, "/claim", map[string]any{"runner": runner, "capacityVersion": c.config.Version, "producerId": c.producerID, "claimRequestId": c.requestID}, &x); err != nil {
		return x, err
	}
	switch x.Kind {
	case "wait":
		if x.Reason != "queue" && x.Reason != "capacity" {
			return x, fmt.Errorf("capacity wait invalid")
		}
		c.requestID = ""
	case "claim", "recover-owned-secret", "quarantined-unrecoverable-token":
		if x.Kind == "quarantined-unrecoverable-token" && x.Receipt == nil && x.RunID != "" && x.JobName == queueJobName(x.RunID) {
			retired, err := c.command(ctx, map[string]any{"action": "inspect-retired", "runId": x.RunID})
			if err != nil {
				return x, err
			}
			if retired.Retirement == nil || !retired.Retirement.Released || retired.Retirement.RunID != x.RunID || retired.Retirement.JobName != x.JobName {
				return x, fmt.Errorf("unverified retired claim replay")
			}
			// This incarnation's exact unresolved request is permanently retired.
			// Future claims use a new registered incarnation, never revive it.
			c.requestID = ""
			c.producerID = newCapacityIdentity()
			c.registered = false
			return x, nil
		}
		if x.Receipt == nil || !x.Receipt.valid(c.config.PoolID, x.RunID) || x.JobName != queueJobName(x.RunID) {
			return x, fmt.Errorf("capacity claim fence invalid")
		}
		if x.Kind == "claim" && (x.Token == "" || (x.Pipeline != "claude" && x.Pipeline != "codex" && x.Pipeline != "opencode")) {
			return x, fmt.Errorf("capacity claim credential invalid")
		}
		// Resolve the request only after observing the exact durable answer. Launch
		// ambiguity remains on its receipt; no receipt is freed here.
		c.requestID = ""
	default:
		return x, fmt.Errorf("capacity claim discriminator invalid")
	}
	return x, nil
}
