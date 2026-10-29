const WORK_DIR_NAME = 'project';
export const WORK_DIR = `/home/${WORK_DIR_NAME}`;

/**
 * The command the agent's exec tool runs as the project's full validation, the one a publish recognizes. It is
 * recognized only run alone, exactly as written; the container's own `cloudchef` command says so otherwise.
 */
export const VALIDATE_COMMAND = 'cloudchef validate';
