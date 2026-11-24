const { randomUUID } = require('node:crypto');

function validateConcurrency(value) {
  if (!Number.isInteger(value) || value < 1 || value > 8) throw new Error('Choose between 1 and 8 concurrent jobs.');
  return value;
}

class ExportQueue {
  constructor(worker, { concurrency = 1, onUpdate = () => {} } = {}) {
    if (typeof worker !== 'function' || typeof onUpdate !== 'function') throw new Error('Invalid export queue handlers.');
    this.worker = worker;
    this.onUpdate = onUpdate;
    this.concurrency = validateConcurrency(concurrency);
    this.id = null;
    this.jobs = [];
    this.running = new Map();
    this.waiters = [];
  }

  start(items) {
    if (this.isActive()) throw new Error('The current export batch is still running.');
    if (!Array.isArray(items) || items.length === 0 || items.length > 500) throw new Error('Select between 1 and 500 export jobs.');
    const jobs = items.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid export job.');
      return {
        id: typeof item.id === 'string' && item.id ? item.id : randomUUID(),
        item: structuredClone(item),
        status: 'queued',
        stage: 'Waiting',
        progress: 0,
        error: null,
        result: null,
      };
    });
    if (new Set(jobs.map(job => job.id)).size !== jobs.length) throw new Error('Export jobs must have unique IDs.');
    this.id = randomUUID();
    this.jobs = jobs;
    this.pump();
    return this.snapshot();
  }

  isActive() {
    return this.running.size > 0 || this.jobs.some(job => job.status === 'queued');
  }

  status() {
    if (!this.id) return 'idle';
    if (this.isActive()) return 'running';
    if (this.jobs.some(job => job.status === 'failed')) return 'failed';
    if (this.jobs.some(job => job.status === 'cancelled')) return 'cancelled';
    return 'completed';
  }

  snapshot() {
    const progress = this.jobs.reduce((total, job) => total + job.progress, 0);
    return {
      id: this.id,
      status: this.status(),
      overallProgress: this.jobs.length ? Math.round(progress / this.jobs.length) : 0,
      jobs: structuredClone(this.jobs),
    };
  }

  publish() {
    try {
      this.onUpdate(this.snapshot());
    } catch (error) {
      console.error('Could not publish export progress:', error);
    }
  }

  pump() {
    for (const job of this.jobs) {
      if (this.running.size >= this.concurrency) break;
      if (job.status !== 'queued') continue;
      const control = { abort: new AbortController(), finalStatus: null };
      job.status = 'running';
      job.stage = 'Starting';
      this.running.set(job.id, control);
      void this.run(job, control);
    }
    this.publish();
    if (!this.isActive()) {
      for (const resolve of this.waiters.splice(0)) resolve(this.snapshot());
    }
  }

  async run(job, control) {
    // Give the caller a chance to observe the running state before work begins.
    await Promise.resolve();
    const { signal } = control.abort;
    try {
      signal.throwIfAborted();
      const result = await this.worker(structuredClone(job.item), {
        signal,
        report: (stage, percent) => {
          if (job.status !== 'running' || signal.aborted) return;
          const progress = Number.isFinite(percent) ? Math.max(job.progress, Math.min(100, Math.floor(percent))) : job.progress;
          const label = typeof stage === 'string' && stage ? stage : job.stage;
          if (progress === job.progress && label === job.stage) return;
          job.progress = progress;
          job.stage = label;
          this.publish();
        },
      });
      signal.throwIfAborted();
      job.result = structuredClone(result ?? null);
      job.status = 'completed';
      job.stage = 'Complete';
      job.progress = 100;
    } catch (error) {
      if (control.finalStatus) {
        job.status = control.finalStatus;
        job.stage = control.finalStatus === 'skipped' ? 'Skipped' : 'Cancelled';
      } else {
        job.status = 'failed';
        job.stage = 'Failed';
        job.error = error instanceof Error ? error.message : String(error);
      }
    } finally {
      this.running.delete(job.id);
      this.pump();
    }
  }

  setConcurrency(concurrency) {
    this.concurrency = validateConcurrency(concurrency);
    this.pump();
    return this.snapshot();
  }

  waitForIdle() {
    if (!this.isActive()) return Promise.resolve(this.snapshot());
    return new Promise(resolve => this.waiters.push(resolve));
  }

  stop(job, status) {
    const control = this.running.get(job.id);
    if (control) {
      if (control.finalStatus) return;
      control.finalStatus = status;
      job.stage = status === 'skipped' ? 'Skipping' : 'Cancelling';
      control.abort.abort();
      return;
    }
    job.status = status;
    job.stage = status === 'skipped' ? 'Skipped' : 'Cancelled';
  }

  cancel() {
    for (const job of this.jobs) {
      if (job.status === 'queued' || job.status === 'running') this.stop(job, 'cancelled');
    }
    this.pump();
    return this.snapshot();
  }

  retry(id) {
    const jobs = this.jobs.filter(job => (id === undefined || job.id === id) &&
      ['failed', 'cancelled', 'skipped'].includes(job.status));
    if (jobs.length === 0) throw new Error('No matching export can be retried.');
    for (const job of jobs) {
      job.status = 'queued';
      job.stage = 'Waiting';
      job.progress = 0;
      job.error = null;
      job.result = null;
    }
    this.pump();
    return this.snapshot();
  }

  skip(id) {
    const job = this.jobs.find(item => item.id === id);
    if (!job || !['running', 'queued', 'failed'].includes(job.status)) throw new Error('This export can no longer be skipped.');
    this.stop(job, 'skipped');
    this.pump();
    return this.snapshot();
  }
}

module.exports = { ExportQueue };
