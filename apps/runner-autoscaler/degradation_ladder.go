package main

import (
	"context"
	"log/slog"
	"time"
)

// runDegradationLadderRefresher periodically queries Prometheus for every
// ladder-enabled lane's observed p95 memory figure and stores it on fleet
// for pickHostLocked's rung 2 to consult (agent-lcars#1697,
// docs/fleet-scheduler-redesign.md#D). Placement never waits on this loop --
// it only ever reads whatever fleet.getObservedMemory last cached, and
// treats a stale or absent sample as "skip rung 2", not as an error.
//
// A no-op loop when no prometheus_url is configured, regardless of any
// lane's own enablement, since rung 2 has nothing to query without one; a
// lane can still reach rung 3. Cheap enough to always start -- mirroring
// RunHostSampler's own always-on pattern -- rather than threading a
// separate "is anything enabled" decision through startRuntimeGeneration.
func runDegradationLadderRefresher(ctx context.Context, runtimes []*scaleSetRuntime, fleet *FleetCoordinator, ladder resolvedDegradationLadder) {
	if ladder.PrometheusURL == "" || ladder.RefreshInterval <= 0 {
		return
	}
	client := newPrometheusClient(ladder.PrometheusURL)
	refreshOne := func(rt *scaleSetRuntime) {
		scaler := rt.scaler
		if !scaler.degradationLadderEnabled {
			return
		}
		scaleSet := scaler.scaleSetLabel()
		query, err := ladder.render(scaleSet)
		if err != nil {
			scaler.logger.Error("Degradation ladder observed_query template failed; skipping this lane's refresh",
				slog.String("scale_set", scaleSet), slog.Any("error", err))
			return
		}
		value, err := client.InstantQuery(ctx, query)
		if err != nil {
			// Fails open: rung 2 is skipped once the cached sample (if any)
			// exceeds fleet.observedMemoryMaxAge -- see
			// degradationLadderObservedP95 -- never blocking placement here.
			scaler.logger.Warn("Degradation ladder observed-p95 query failed; rung 2 uses the last known sample, or is skipped if none exists",
				slog.String("scale_set", scaleSet), slog.Any("error", err))
			if sample, ok := fleet.getObservedMemory(scaleSet); ok {
				laneObservedMemoryAgeGauge.WithLabelValues(scaleSet).Set(time.Since(sample.at).Seconds())
			}
			return
		}
		fleet.setObservedMemory(scaleSet, value, time.Now())
		laneObservedMemoryP95Gauge.WithLabelValues(scaleSet).Set(value)
		laneObservedMemoryAgeGauge.WithLabelValues(scaleSet).Set(0)
		scaler.logger.Debug("Refreshed degradation ladder observed p95",
			slog.String("scale_set", scaleSet), slog.Float64("observed_p95_bytes", value))
	}
	refresh := func() {
		for _, rt := range runtimes {
			refreshOne(rt)
		}
	}
	refresh()
	ticker := time.NewTicker(ladder.RefreshInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			refresh()
		}
	}
}
