/**
 * Browser key-code map for formal keyboard-only Tetris trials.
 *
 * Requirement links: `FR-GAME-011`, `FR-UI-009`, and `FR-PERF-002`.
 * Keeping pause/quit in the same map lets event logging distinguish accepted
 * gameplay controls from trial-control keys without adding pointer controls.
 */
export const FORMAL_KEYBOARD_MAP = {
  ArrowLeft: 'move_left',
  ArrowRight: 'move_right',
  ArrowDown: 'soft_drop',
  ArrowUp: 'rotate_clockwise',
  KeyZ: 'rotate_counterclockwise',
  Space: 'hard_drop',
  KeyP: 'pause',
  Escape: 'quit',
};

/**
 * Converts a browser key code to a formal Tetris action.
 *
 * Requirement links: `FR-GAME-011` and `FR-PERF-002`.
 * Keeping the mapping in one small module makes the keyboard-only trial policy
 * testable and avoids pointer/touch controls entering formal data collection.
 *
 * @param {string} code Browser keyboard event code.
 * @returns {string | null} Canonical action/event name.
 */
export function mapKeyboardCode(code) {
  return FORMAL_KEYBOARD_MAP[code] ?? null;
}
