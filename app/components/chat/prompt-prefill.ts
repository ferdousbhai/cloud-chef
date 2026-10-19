import { createContext } from 'react';

/**
 * Whether an unstarted composer may restore the homepage's draft (`?prefill=` or the prompt kept
 * across sign-in). Only a new project may: an existing one that has no messages yet is not where
 * that draft was written, and offering it there sends someone else's idea to the wrong project.
 */
export const PromptPrefillContext = createContext(true);
