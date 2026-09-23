// Coordinates come from the QuickApp TouchEvent, in the page coordinate space.
function point(event, ending) {
  const touches = event && (ending ? event.changedTouches : event.touches);
  const touch = touches && touches[0];
  if (!touch || !Number.isFinite(touch.clientX) || !Number.isFinite(touch.clientY)) return null;
  return { x: touch.clientX, y: touch.clientY, id: touch.identifier };
}

export class TouchGesture {
  constructor() { this.cancel(); }

  cancel() { this.state = null; }

  begin(event, action, now) {
    const p = point(event, false);
    if (!p || event.touches.length !== 1) { this.cancel(); return; }
    const old = this.state;
    // The button's start also bubbles to the page. Preserve its queued action.
    if (!action && old && old.action && old.id === p.id && old.x === p.x && old.y === p.y) return;
    this.state = { ...p, time: now, action: action || '', moved: false, axis: '', invalid: false };
  }

  move(event) {
    const s = this.state;
    if (!s) return null;
    const p = point(event, false);
    if (!p || event.touches.length !== 1 || p.id !== s.id) { s.invalid = true; return null; }
    this.observe(p);
    // Lists may claim the release after scrolling starts. Commit an unambiguous
    // horizontal drag while moving; cancellation prevents a second navigation.
    const dx = p.x - s.x, dy = p.y - s.y;
    if (!s.invalid && s.axis === 'horizontal' && Math.abs(dx) >= 64 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      this.cancel();
      return { pageDelta: dx < 0 ? 1 : -1 };
    }
    return null;
  }

  observe(p) {
    const s = this.state;
    const dx = Math.abs(p.x - s.x), dy = Math.abs(p.y - s.y);
    if (Math.max(dx, dy) > 14) s.moved = true;
    if (!s.axis && Math.max(dx, dy) >= 24) {
      if (dy > dx * 1.2) s.axis = 'vertical';
      else if (dx > dy * 1.5) s.axis = 'horizontal';
    }
  }

  end(event, now) {
    const s = this.state;
    const p = point(event, true);
    if (!s) return null;
    if (p) this.observe(p);
    this.cancel(); // Child and parent may both see the same release.
    if (!p || s.invalid || p.id !== s.id || (event.touches && event.touches.length)) return null;
    // Inference can delay dispatch by seconds. Wall-clock latency is not a
    // reliable indication of the user's intent on the board.
    const dx = p.x - s.x, dy = p.y - s.y;
    if (s.axis === 'horizontal' && Math.abs(dx) >= 64 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      return { pageDelta: dx < 0 ? 1 : -1 };
    }
    if (!s.moved && s.action) return { action: s.action };
    return null;
  }
}
