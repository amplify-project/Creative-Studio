/**
 * Serialize track publish/unpublish operations per room.
 *
 * MediaControls already chains its mic operations through a `useRef` promise,
 * for reasons that cost a field session to learn — see docs/llm/08 and the
 * comment on `runAudioOp`. That ref only serializes callers inside that one
 * component, which was enough while it was the only thing publishing.
 *
 * It no longer is: a second camera and a screen share are published from the
 * control panel. A ref cannot serialize across components, so the chain lives
 * here instead, keyed on the Room object itself. Anything holding the same
 * room queues against the same chain whatever tree it renders in.
 *
 * `lane` keeps independent media independent — a mic toggle has no reason to
 * wait behind a screen-share picker the user is still looking at. Operations
 * on the same lane run strictly in order, each reading room state after the
 * previous one has fully settled.
 */

const chains = new WeakMap<object, Map<string, Promise<unknown>>>();

export type PublishLane = "audio" | "video";

export function runPublishOp<T>(
  room: object | null | undefined,
  lane: PublishLane,
  fn: () => Promise<T>,
): Promise<T> {
  // No room: nothing to serialize against, and the caller's own error
  // handling is a better place to notice than a silent queue.
  if (!room) return fn();

  let lanes = chains.get(room);
  if (!lanes) {
    lanes = new Map();
    chains.set(room, lanes);
  }
  const previous = lanes.get(lane) ?? Promise.resolve();

  // Run whether the previous op resolved or rejected, so one failure doesn't
  // wedge the lane forever.
  const result = previous.then(fn, fn);
  lanes.set(lane, result.then(() => undefined, () => undefined));
  return result;
}
