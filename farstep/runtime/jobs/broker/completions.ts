import type { Socket } from "node:net";
import type { JobWireRequest } from "farstep/protocol/jobs/protocol";

import type { ManagedJob } from "./model";

interface Registration {
  socket: Socket | undefined;
  subscription: string | undefined;
}
export class JobCompletions {
  readonly #owners = new Map<string, Registration>();
  constructor(
    private readonly jobs: Map<string, ManagedJob>,
    private readonly persist: (job: ManagedJob) => Promise<void>,
  ) {}

  has(owner: string): boolean {
    return this.#owners.has(owner);
  }

  disconnect(socket: Socket): void {
    for (const registration of this.#owners.values()) {
      if (registration.socket === socket) registration.socket = undefined;
    }
  }

  deliver(job: ManagedJob): void {
    const socket = job.snapshot.owner
      ? this.#owners.get(job.snapshot.owner)?.socket
      : undefined;
    for (const event of job.pending) socket?.write(`${JSON.stringify(event)}\n`);
  }

  async register(socket: Socket, request: JobWireRequest): Promise<void> {
    await this.#unsubscribe(request);
    await this.#acknowledge(socket, request);
    if (!request.completionEvents || request.completionAcks?.length) return;
    const active = new Set(request.owners ?? []);
    const preserved = new Set(request.detachedOwners ?? []);
    for (const [owner, registration] of this.#owners) {
      if (
        registration.subscription !== request.completionSubscriptionId ||
        active.has(owner) ||
        preserved.has(owner)
      )
        continue;
      await this.#forgetOwner(owner);
    }
    for (const owner of [...active, ...preserved])
      await this.#subscribeOwner(owner, socket, request, active, preserved);
  }

  async #unsubscribe(request: JobWireRequest): Promise<void> {
    for (const owner of request.completionUnsubscribes ?? []) {
      if (this.#owners.get(owner)?.subscription !== request.completionSubscriptionId)
        continue;
      await this.#forgetOwner(owner);
    }
  }

  async #acknowledge(socket: Socket, request: JobWireRequest): Promise<void> {
    for (const job of this.jobs.values()) {
      const registration = job.snapshot.owner
        ? this.#owners.get(job.snapshot.owner)
        : undefined;
      if (
        registration?.socket !== socket ||
        registration.subscription !== request.completionSubscriptionId
      )
        continue;
      const pending = job.pending.filter(
        (event) => !request.completionAcks?.includes(event.completionId),
      );
      if (pending.length !== job.pending.length) {
        job.pending = pending;
        await this.persist(job);
      }
    }
  }

  async #subscribeOwner(
    owner: string,
    socket: Socket,
    request: JobWireRequest,
    active: Set<string>,
    preserved: Set<string>,
  ): Promise<void> {
    const previous = this.#owners.get(owner);
    if (
      preserved.has(owner) &&
      previous &&
      previous.subscription !== request.completionSubscriptionId
    )
      return;
    const registration = {
      socket: active.has(owner) ? socket : undefined,
      subscription: request.completionSubscriptionId,
    };
    this.#owners.set(owner, registration);

    for (const job of this.jobs.values()) {
      if (job.snapshot.owner !== owner) continue;
      await this.#enableCompletion(job, registration, previous, request, owner);
    }
  }

  async #enableCompletion(
    job: ManagedJob,
    registration: Registration,
    previous: Registration | undefined,
    request: JobWireRequest,
    owner: string,
  ): Promise<void> {
    if (!job.capable) {
      job.capable = true;
      await this.persist(job);
    }
    if (
      registration.socket &&
      (previous?.socket !== registration.socket ||
        request.completionReplays?.includes(owner))
    ) {
      for (const event of job.pending)
        registration.socket.write(`${JSON.stringify(event)}\n`);
    }
  }

  async #forgetOwner(owner: string): Promise<void> {
    this.#owners.delete(owner);
    for (const job of this.jobs.values()) {
      if (job.snapshot.owner !== owner) continue;
      job.capable = false;
      job.pending = [];
      await this.persist(job);
    }
  }
}
