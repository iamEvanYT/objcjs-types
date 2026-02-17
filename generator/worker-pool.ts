/**
 * Worker pool for parallel header parsing.
 * Manages a fixed pool of worker threads and distributes parse tasks
 * with automatic load balancing via an internal queue.
 *
 * Each worker runs clang + AST parsing independently. The pool routes
 * tasks to idle workers and queues excess tasks until a worker is free.
 */

import type { ObjCClass, ObjCProtocol } from "./ast-parser.ts";

export interface ClassParseResult {
  /** Parsed classes from the header (class name → ObjCClass) */
  classes: Map<string, ObjCClass>;
  /** Original target class names that were requested */
  targets: string[];
}

export interface ProtocolParseResult {
  /** Parsed protocols from the header (protocol name → ObjCProtocol) */
  protocols: Map<string, ObjCProtocol>;
  /** Original target protocol names that were requested */
  targets: string[];
}

interface PendingTask {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
}

interface QueuedTask {
  message: any;
  resolve: (value: any) => void;
  reject: (error: Error) => void;
}

/**
 * Pool of worker threads for running clang + AST parsing in parallel.
 * Tasks are automatically load-balanced: each new task goes to an idle
 * worker, or queues until one becomes available.
 */
export class WorkerPool {
  private workers: Worker[];
  private idle: Worker[];
  private queue: QueuedTask[];
  private pending: Map<Worker, PendingTask>;
  private nextId = 0;

  constructor(size: number) {
    const workerUrl = new URL("./parse-worker.ts", import.meta.url).href;
    this.workers = [];
    this.idle = [];
    this.queue = [];
    this.pending = new Map();

    for (let i = 0; i < size; i++) {
      const worker = new Worker(workerUrl, { smol: true });
      worker.onmessage = (event) => this.onWorkerMessage(worker, event.data);
      worker.onerror = (event) => this.onWorkerError(worker, event);
      this.workers.push(worker);
      this.idle.push(worker);
    }
  }

  /** Number of workers in the pool. */
  get size(): number {
    return this.workers.length;
  }

  private onWorkerMessage(worker: Worker, data: any): void {
    const task = this.pending.get(worker);
    this.pending.delete(worker);

    if (data.type === "error") {
      task?.reject(new Error(data.error));
    } else {
      task?.resolve(data);
    }

    this.dispatchNext(worker);
  }

  private onWorkerError(worker: Worker, event: Event | ErrorEvent): void {
    const task = this.pending.get(worker);
    this.pending.delete(worker);
    const msg = event instanceof ErrorEvent ? event.message : "Worker error";
    task?.reject(new Error(msg));
    this.dispatchNext(worker);
  }

  /** Send the next queued task to a now-idle worker, or mark it idle. */
  private dispatchNext(worker: Worker): void {
    const next = this.queue.shift();
    if (next) {
      this.pending.set(worker, { resolve: next.resolve, reject: next.reject });
      worker.postMessage(next.message);
    } else {
      this.idle.push(worker);
    }
  }

  /** Send a message to an available worker, or queue it. */
  private dispatch(message: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const worker = this.idle.pop();
      if (worker) {
        this.pending.set(worker, { resolve, reject });
        worker.postMessage(message);
      } else {
        this.queue.push({ message, resolve, reject });
      }
    });
  }

  /**
   * Parse classes from a header file using a worker thread.
   * Automatically retries with fallback pre-includes if initial parse finds nothing.
   */
  async parseClasses(
    headerPath: string,
    targets: string[],
    fallbackPreIncludes?: string[]
  ): Promise<ClassParseResult> {
    const result = await this.dispatch({
      id: this.nextId++,
      type: "parse-classes",
      headerPath,
      targets,
      fallbackPreIncludes,
    });
    return {
      classes: new Map(result.classes),
      targets: result.targets,
    };
  }

  /**
   * Parse protocols from a header file using a worker thread.
   * Automatically retries with fallback pre-includes if initial parse finds nothing.
   */
  async parseProtocols(
    headerPath: string,
    targets: string[],
    fallbackPreIncludes?: string[]
  ): Promise<ProtocolParseResult> {
    const result = await this.dispatch({
      id: this.nextId++,
      type: "parse-protocols",
      headerPath,
      targets,
      fallbackPreIncludes,
    });
    return {
      protocols: new Map(result.protocols),
      targets: result.targets,
    };
  }

  /** Terminate all workers and clean up resources. */
  destroy(): void {
    for (const worker of this.workers) {
      worker.terminate();
    }
    this.workers = [];
    this.idle = [];
    this.queue = [];
    this.pending.clear();
  }
}
