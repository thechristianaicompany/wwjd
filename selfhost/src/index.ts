import { createDecisionsClient, decide, ENGINE_VERSION, DEFAULT_PROMPT_SET_ID } from '@wwjd/engine';
import * as corpus from '@wwjd/corpus';
import { createHandler } from './handler.ts';

export default {
  fetch: createHandler({
    createDecisionsClient, decide, corpus,
    engineVersion: ENGINE_VERSION,
    promptVersion: DEFAULT_PROMPT_SET_ID,
  }),
};
