package main

import (
	"sort"
	"sync"

	batch "k8s.io/api/batch/v1"
)

// A bounded sweep starts after its last attempted identity, even when that
// Job was deleted or the attempt exhausted the budget. Slow early Jobs must
// not indefinitely hide a later settled claim. Recovery and cleanup own
// independent cursors because their single-flight sweeps may overlap.
type queueSweepCursor struct {
	mu   sync.Mutex
	last string
}

func (c *queueSweepCursor) ordered(jobs []batch.Job) []batch.Job {
	c.mu.Lock()
	last := c.last
	c.mu.Unlock()
	sort.Slice(jobs, func(i, j int) bool { return jobs[i].Name < jobs[j].Name })
	start := sort.Search(len(jobs), func(i int) bool { return jobs[i].Name > last })
	if start == len(jobs) {
		start = 0
	}
	return append(jobs[start:], jobs[:start]...)
}

func (c *queueSweepCursor) visit(name string) {
	c.mu.Lock()
	c.last = name
	c.mu.Unlock()
}
