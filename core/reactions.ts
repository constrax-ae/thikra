// The reactions a message may carry.
//
// This lives in core/ because the web picker and the server's validator must agree: when
// the picker was widened and this set was not, every reaction outside the original six
// came back as `invalid_reaction` and the person just saw "something went wrong". Both
// sides now read the same list, so they cannot drift apart again.
//
// The set is deliberately bounded rather than "any emoji": the column is indexed and
// grouped per message, and an open field invites junk from a pasted string.

/** The six offered as a single tap, the ones people actually use. */
export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'] as const;

/** Everything a reaction may be, the quick six first so the picker can slice them off. */
export const ALL_REACTIONS: readonly string[] = [
  ...QUICK_REACTIONS,
  '👎', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '💔', '❣️', '💕',
  '😀', '😃', '😄', '😁', '😆', '😅', '🤣', '🙂', '🙃', '😉', '😊',
  '😇', '🥰', '😍', '🤩', '😘', '😗', '😚', '😙', '🥲', '😋', '😛',
  '😜', '🤪', '😝', '🤗', '🤭', '🤫', '🤔', '🤐', '😐', '😶', '😏',
  '😒', '🙄', '😬', '😯', '😲', '🥱', '😴', '🤤', '😪', '😵', '🤯',
  '🥳', '😎', '🤓', '🧐', '😕', '😟', '🙁', '😭', '😤', '😠', '😡',
  '🤬', '🥺', '😳', '🤧', '🤒', '🤕', '🤢', '🤮', '🥵', '🥶', '😱',
  '😨', '😰', '👏', '🙌', '👐', '🤲', '🤝', '💪', '✌️', '🤞', '👌',
  '👈', '👉', '🔥', '✨', '🎉', '🎊', '🎁', '🏆', '⭐', '🌟', '💯',
  '✅', '❌', '⚡', '🌹', '🌸', '🌼', '🌻', '🍀', '🌙', '☀️', '🌈',
  '☕', '🍰', '🎂', '🕌', '🤲🏼', '📿',
];

/** What the server checks an incoming reaction against. */
export const REACTIONS = new Set(ALL_REACTIONS);
