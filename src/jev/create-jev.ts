import { ConsoleJev } from './console-jev.js';
import { LoggingJev } from './logging-jev.js';
import { ProgressiveStubJev } from './progressive-stub.js';
import type { SupervisorAdvisor } from './supervisor-advisor.js';

/**
 * Always ProgressiveStubJev (via LoggingJev). HttpJev / TypeSafe is removed from
 * the live bot path — tokens in env are ignored. `-v` wraps with ConsoleJev.
 */
export function createSupervisor(verbose: boolean): SupervisorAdvisor {
  const base: SupervisorAdvisor = new LoggingJev(
    new ProgressiveStubJev(),
    'ProgressiveStubJev',
  );
  return verbose ? new ConsoleJev(base) : base;
}

/** @deprecated Use createSupervisor for autopilot; kept for CLI commands. */
export function createJev(verbose: boolean): SupervisorAdvisor {
  return createSupervisor(verbose);
}
