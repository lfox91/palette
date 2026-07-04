/** The default reviewer: approve as-is. Instant, offline, no dependencies. */

import type { MoodInput, PaletteSuggestion, RawPalette } from '../types.js';
import type { ReviewBackend } from './index.js';

export const noneReviewer: ReviewBackend = {
  mode: 'none',
  review(_palette: RawPalette, _input: MoodInput): Promise<PaletteSuggestion> {
    return Promise.resolve({ approved: true, rationale: 'no review (mode: none)', tweaks: [] });
  },
};
