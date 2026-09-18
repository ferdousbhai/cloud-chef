import { WORK_DIR } from 'cloudchef-agent/constants';

export const PENDING_PROMPT_STORAGE_KEY = 'cloudchef:pending-prompt';

/** The prompt a submit was carrying when it stopped to connect Cloudflare, so it can resume. */
export const PENDING_SUBMIT_STORAGE_KEY = 'cloudchef:pending-submit';

export const DEFAULT_COLLAPSED_FOLDERS = new Set([
  `${WORK_DIR}/public`,
  `${WORK_DIR}/.output`,
  `${WORK_DIR}/.tanstack`,
  `${WORK_DIR}/.wrangler`,
  `${WORK_DIR}/src/agents`,
  `${WORK_DIR}/src/components`,
  `${WORK_DIR}/src/lib`,
]);
