import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView } from '@codemirror/view';
import { invertedEffects } from '@codemirror/commands';
import type { SearchMatch } from './search-core';

export const setSourceVersion = StateEffect.define<string>();
export const sourceVersion = StateField.define<string>({
  create: () => '', update: (value, transaction) => transaction.effects.reduce((current, effect) => effect.is(setSourceVersion) ? effect.value : current, value),
});
export const sourceVersionHistory = invertedEffects.of(transaction => transaction.effects.some(effect => effect.is(setSourceVersion)) ? [setSourceVersion.of(transaction.startState.field(sourceVersion))] : []);

export const setSourceMatches = StateEffect.define<{ matches: SearchMatch[]; current: number }>();
export const sourceSearchHighlights = StateField.define({
  create: () => Decoration.none,
  update(value, transaction) {
    let next = value.map(transaction.changes);
    for (const effect of transaction.effects) if (effect.is(setSourceMatches)) next = Decoration.set(effect.value.matches.map((match, index) => Decoration.mark({ class: index === effect.value.current ? 'croquill-search-current' : 'croquill-search-match' }).range(match.from, match.to)), true);
    return next;
  },
  provide: field => EditorView.decorations.from(field),
});
