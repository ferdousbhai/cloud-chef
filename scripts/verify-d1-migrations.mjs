import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runVerifierIfMain } from './run-verifier.mjs';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const migrationNamePattern = /^(\d{4})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;

// Every migration is pinned by its SHA-256 checksum, so one that may have been applied can never be edited, and a
// new one ships only once its checksum is recorded here. Changes stay additive (expand/contract safe) unless the
// migration is named in its directory's `contractAllowlist`, the reviewed exceptions; the checksum pins what was
// reviewed.
const migrationPolicies = [
  {
    directory: 'migrations',
    checksums: {
      '0001_ghostbuild.sql': 'b4ea60ce99e8dafacafc566cdbbf9efdd7668963072b8b5f0860b4cdd8ebdb7a',
      '0002_user_computer_runtimes.sql': 'a9056622b927693b1dbe19669a6442af96388e8ca8b7ca1e55d1e087419ea3ed',
      '0003_launch_controls.sql': 'a9aaab709aabf2db221379e2449c78602aa1d44730f0d9984f185fa2dbad4bd3',
      '0004_remove_legacy_workspace_runtime.sql': 'fd0a0a6a4297ccc046216ff11216bb217afaaeb399548501a2581f7e4450ae5f',
      '0005_runtime_provisioning_leases.sql': '2e485f09167d3a71bf12d20729933be5da35fd25ce91f613a0d6964b2be62c07',
      '0006_remove_launch_controls.sql': '48cb5986ca4291a46609b4714747878adb197dea2024d6c0a8bdd817327bb99f',
      '0007_upstream_monitor_runs.sql': 'f89ee7f275f15543cdf0e96c4bb78acafc8419c0dacb946b96f9d9e53dbe439b',
      '0008_remove_upstream_monitor_runs.sql': '1ca903265be41d756da88c11dcebdec0547309bf4f5fc24c82b2fd9b9f295112',
      '0009_builder_skill_sync.sql': '22d04accde975bceee06ddba21343ff560b31582ab44235017c924daf5a752bf',
      '0010_daily_maintenance_receipts.sql': 'b6b5185e35ed10ce4f29bb0c95b19e65a2b78039c0ae77d42ba5972300244748',
      '0011_reconcile_skipped_listings.sql': '2041b644d89494af371aa6dc9f87d77df9681f55c76d93aa58ae5e7d9c563192',
      '0012_remove_builder_skill_sync.sql': '5731448cabed0deec30178e99a87419103d1f9a96ca1ecbc6bdc5d36ecf1a708',
      '0013_user_workspace_runtime_resources.sql': '7e62570b5855931557058c1bcf9561b61c6ea90ba34bdf6efb88b5c7c1609fd9',
      '0014_workspace_runtime_upgrade_deferral.sql': '1a9e1598b98fb487bb065f3b6574a6045ed4e76e9d88089d8a111f91b62311b1',
      '0015_workspace_runtime_image_digest.sql': '215c693d9dfb3c726559a6dc218f0cdf6f22d5eec8788dd376853c4868dc2748',
      '0016_cloudflare_oauth_grants.sql': '6e5ef8504184115c70e344f2fdd86c8adc3dfb78becb50cddfe5bf315ff174f9',
      '0017_drop_granted_scopes_json.sql': 'afd3fdd37bc396fea58da077118a9da38d99aaab764994910ab1141829f2501f',
      '0018_remove_user_workspace_runtime_resources.sql':
        'd7f9e902632e82e7750e6bfd4cd986d981a14b4199188f1bdc00f17e79664918',
      '0019_remove_dead_control_plane_schema.sql': 'cf136090e98b908ec89166f224a7416381d4d67feffe8f12058f041c3d35073a',
      '0020_member_sign_in.sql': 'b5b04da2845b9f4d03dcd2df2f438fb11076091b00a4c031f8197ec41fd6d82e',
      '0021_organizations.sql': 'c181f20c983af3a41e36fb9723d9e4987b2e997cef044ae814e22ac1d6421f61',
      '0022_github_projects.sql': '3e9b4e9192a53c49be52bf185822dd5f4b946f554b43297168ef7e7eec94da0a',
      '0023_production_requests.sql': '8a3e6faa722489cac40a96f93a7e282013e0122966472c114e516482e7f92014',
      '0024_invite_projects.sql': '35fc087ca702efb95141a43fa845fdb8fdcb1aa9ecdb81b3028cedd13f67e404',
      '0025_production_request_drafts.sql': '48d36c51d715d702696740fc2221aff6dc1ba73d98b3b9d5b0883dc81a15a24c',
      '0026_invite_drafts.sql': '7727a243df91e2ebd84a465dbd43d173d75f32ae9dc483ebdf5451ef82a55651',
      '0027_ai_gateway_content_logging.sql': '1ce6663769be8183f49933e933aa1499b84f26527f46942f125e8b67d6810e25',
      '0028_workspace_runtime_upgrade_window.sql': '1ab6abb5acb8e4874a450bb4b2590cb39563c8e0f0d98f699dcc363e53692b9c',
      '0029_default_builder_model.sql': '92f8da314979083b5a3139cc5e0a6f7b9cff32409bf1dac5bbb9bdb529a21fc5',
      '0030_organization_quota_events.sql': 'a840b9ffea1d8a68bfc003faa5df6a67ef0738b91b3e099e9eb558172ce62d5a',
      '0031_drop_ai_billing_enabled.sql': '759babf4f25026871c9b86d77e8a3dae707e0309184dabb81f213dac287b902c',
      '0032_drop_oauth_grant_columns.sql': '4a5d586765bae8eb120962aaed96ef487a74f4cb69cb7d9b6a6a5fe69bb3824a',
      '0033_artifact_projects.sql': '90c7a266c7e4b92d045c1072eaa32c7bf7cdb6323423f497abff3fd64ce5866f',
      '0034_github_installations_per_account.sql': '048d63a3efd77be1f33b81241c841abf7176b49145338ea6655b734ae4343618',
      '0035_cloudflare_authorizations.sql': '85af7ceb277998492e72fc73524960b7ff1250fd5a3aa39324639a7eea6d25be',
      '0036_allowed_builder_models.sql': '4ab08907c7b295feab5ff1f375f2ae979b3ea16bf3648d29c0c00d8a37f1cb48',
      '0037_clear_space_credential_handles.sql': 'ed6c3ba2543744b3e0e9245e6dbffde25b2c507f461bf4494b959f0cca4ec3c6',
      '0038_project_site_frameable.sql': 'd0f8115dc856d919efac78055c02a00b6c046d3aee22df751f3cdfa8462918cd',
      '0039_uploaded_projects.sql': '6834dac950369636d41a810841816b817f78e387c270cda8d0d1ff4c8aaae76e',
      '0040_cloudchef_deploys.sql': '998feb5f942e5a9f2a74357ff9d67525e0ab2fdb3e9645eb3b12fa32abdce31b',
      '0041_deployment_steps.sql': '4d1c4b47b31c56d9c91cfbcec195a4c0144ad160c6bae65fa265c89176cd64c5',
      '0042_command_line_tokens.sql': '502949c032ecb59a7ec1aa2b2673f52bbba6786ae81ea88a5b154151d59400ff',
      '0043_command_line_logins.sql': 'd23f910c28ed098dafe79f204f1a5c337205f123765e2ac10ee6c298b752f113',
      '0044_usernames_and_project_names.sql': '7afddbde67bc6c0e772baa8c1913efbb1729f702d3111a8d5f376183d3240314',
      '0045_public_projects_and_copies.sql': '3d13ba3566414a00adad5cdf8a2817e11cd25ec861a0dcc5dc8bd0dc5c8f76d0',
      '0046_apps.sql': '8316793cea4e79accd2289e03f70df809dd2902c26b06113b62aee4444f8dfd5',
      '0047_approval_requests.sql': '7a6cd0e2b99fe965f75337de75807fe5b9a16ee4bd16b21ea6c1b0f5b44ac8dc',
      '0048_drop_unused_request_storage.sql': '4f70f804b55f95534d9863579ce07c682c1c177d435270196c2570f432c47b0a',
      '0049_drop_connection_authorization_copies.sql':
        '6ce622590c9dc91b2871ed7eb244c73ca4d2dd94252c54947348df4446f40c42',
      '0050_main_rewrites.sql': '3d88d56295630ab8a5fdfbc87e5f27d155353d9881d3397ab80bfa5bc030f2de',
      '0051_approval_request_sources.sql': 'bc4c7b8122fbf412874fa9315bbfb8fb3be087f38d22e9a3db3895ce53afbe46',
      '0052_main_pushes.sql': '052c3fea4be25ca07f61774a594d0496b8fa7d0a48b0c44a49ad3e3c7b918a48',
      '0053_github_authorization_installations.sql': 'eb492583048f308720c457edc34a1b6b99ddda95a029bd7f49282a864d0567a4',
      '0054_project_visits.sql': 'c6f7866ea570d6e3717eb92ef6b3f333fbb4efebe26bf491c3dcc581d843e305',
      '0055_chat_projects.sql': 'dad4c9ca3ee67540493c250868757259066241ab71febf77ec1ab350a3f9eb78',
    },
    contractAllowlist: [
      // Explicit pre-launch clean break: the Computer locator replaced this
      // unused table, and keeping it would preserve a false compatibility path.
      '0004_remove_legacy_workspace_runtime.sql',
      // Full launch removes the default-off gate that blocked automatic provisioning.
      '0006_remove_launch_controls.sql',
      // Operator receipts moved to the retired private operator database.
      '0008_remove_upstream_monitor_runs.sql',
      // No code reads these tables once skills stop being mirrored; the sync that wrote them is gone.
      '0012_remove_builder_skill_sync.sql',
      // The legacy capability column: 0016 split capabilities from OAuth scopes and the pre-launch
      // dual-write was removed, so nothing reads or writes it.
      '0017_drop_granted_scopes_json.sql',
      // Workspace resource names are derived from the account and user, so the record this table
      // kept is recomputable and its writer and reclamation path are gone.
      '0018_remove_user_workspace_runtime_resources.sql',
      // The daily-maintenance receipts, the reconcile-sweep receipts and the provisioning-lease and
      // upgrade-deferral columns all lost their last reader and writer with the workspace-lifecycle
      // simplification.
      '0019_remove_dead_control_plane_schema.sql',
      // A connection can belong to an organization, and a runtime is keyed by (user, connection): SQLite
      // can't relax NOT NULL or change a primary key in place, so both tables are rebuilt with every row
      // copied. The runtime rows step aside first so dropping the connections can't cascade to them.
      '0021_organizations.sql',
      // Whether a connection bills Workers AI is derived from its granted capabilities. The deploy that
      // ships this no longer names the column, so it is applied after that deploy: until then the
      // column's default covers the new code's writes, and the previous code still finds it.
      '0031_drop_ai_billing_enabled.sql',
      // A connection's grant is its confirmed scope IDs alone; the release before this one stopped naming the
      // capability, requested-scope, profile, status and grant-time columns.
      '0032_drop_oauth_grant_columns.sql',
      // Projects move to Artifacts and belong to a connection: SQLite can't relax NOT NULL, rename columns
      // with their constraints, or change a primary key in place, so the project, access, production
      // request and GitHub tables are rebuilt with every row copied. The access grants and requests step
      // aside first so dropping the projects can't cascade to them.
      '0033_artifact_projects.sql',
      // A connection's GitHub App installations become one row per GitHub account: SQLite can't change a
      // primary key in place, so the table is rebuilt with every row copied, without the unnamed org_id.
      '0034_github_installations_per_account.sql',
      // Projects record what they were made from (`created_from`: github, zip or draft) in place of `origin`,
      // which must stop being required: SQLite can't relax NOT NULL or a CHECK in place, so the project table
      // is rebuilt with every row copied. The access grants and production requests step aside first, as in
      // 0033, so dropping it can't cascade to them.
      '0039_uploaded_projects.sql',
      // Rebuilds org_projects for public projects and copies (created_from's CHECK gains 'copy'), dropping the
      // `origin` column and rollout triggers 0039 and 0040 left for the release after; its dependents step aside.
      '0045_public_projects_and_copies.sql',
      // GitHub approval states and production requests' snapshot and claim columns, unread since drafts are approved
      // into their own Artifacts repository.
      '0048_drop_unused_request_storage.sql',
      // The connection's copies of its account's authorization and their rollout triggers, unread since 0035/0037.
      '0049_drop_connection_authorization_copies.sql',
      // Rebuilds org_projects so created_from's CHECK gains 'chat' (an app made in a chat); its dependents step aside.
      '0055_chat_projects.sql',
    ],
  },
  {
    directory: 'user-workspace-migrations',
    checksums: {
      '0001_user_workspace.sql': '6647c65caa6992a4f418813a5682b86e1fb65bc91fe62d1af4d81fc7482f2ed5',
      '0002_remove_chat_url_id.sql': '0f09b6846af83b969db428ee1177d5b17fbf0210cc1c53368167d65dfb4004f1',
      '0003_app_resource_gc.sql': 'e5fb53955e71aaf07132dab062b66cac9826755d69a729733d7ceafb11b34f2b',
      '0004_chat_title_sources.sql': '0b0d6c74cc07870155320d75f2be2d10d8aac09090db0fbcefcfd84fe19b1af9',
      '0005_deployment_activity.sql': 'a092ceefd76d8e0af1afd73e2d11e03ddcae1e9694fc5673a55f985d65854cbd',
      '0006_runtime_controls.sql': '952b8c35936e312b128eda8aaaf45453a312aef4333f9812a293ef4cc79294e6',
      '0007_builder_agent_transcript_authority.sql': 'ab725f59263f1c754bbef8b3a930bc00bcc63c2978e597b3e169a0d4c84ec616',
      '0008_cloudflare_mcp_runtime_controls.sql': '43f98431a6cce8cdec9ff1d65d42b79aa13740e87c12278a2a134b43394761c6',
      '0009_cloudflare_api_runtime_controls.sql': 'ba63b747dab79622f544d3379a0bae48512b5d6a6d09d67ed3dcaf83c82e46f1',
      '0010_linked_projects.sql': '3207539eadd37e6dd7eae1e241b2924ce13400f70af79ecca57ca6840444e371',
      '0011_linked_chat_history.sql': '48e8758a86aa97c46923d1b4170766c03d30d43f0111da9a9d057df06b4bc37e',
      '0012_runtime_activity.sql': 'e8d8983002c40833631722252c30dab9eca7688264efbb9afa16400ae19c8339',
      '0013_runtime_upgrade_window_holder.sql': '09abd121f50b951d6b8ab162d12f7eeb61471ef5cf72a24188d6a3dee24eeb58',
      '0014_deployment_claim_id.sql': 'f446823bdb02790ecd961c375d3d0c9d89a922cee636f70676bffce8c384d9e5',
      '0015_agent_gc_generation_defaults.sql': '3dbfe2491866d454319d875caa466a1099671ca6d74edbb2379a5f594d91eb7c',
      '0016_remove_runtime_controls.sql': '2215380e3ec544cdf283ea068b67995e8887c9b1cea48a11a3da24597902d5c5',
      '0017_drop_generation_columns.sql': 'c8d690f93662c0db7363b2b280b05d9529289426843c341732735bb5129f0ef9',
      '0018_clone_tokens.sql': '069a24c5d65f112fe1fe7f10d90019daea73b14b870e4ecb7a47cde381f1831d',
      '0019_workspaces_and_conversations.sql': 'b3b45dd9e17b720ff2e9fb3d8a474c887521def321066eb7453808dc93ec155a',
      '0020_adopted_drafts.sql': '28c05df25fcfa771f969bc66896afab8ed2d1683e99bb3ee2b52816e9e01fbf8',
      '0021_drop_clone_tokens.sql': '44a4e7fa605feb3bf838527b5404dbf97845fb0e6fc011ec8635ad958fc05104',
      '0022_clear_project_workspace_names.sql': 'b5f24a2fb0a7653957b56a82c9db86f112ae314c2c0e4647da56d813a596c4f7',
      '0023_base_container_snapshots.sql': '083d89491fb6721eb75f9a841de174995ded613eabfb5d75a4121a7a2f594e54',
      '0024_legacy_chat_moves.sql': 'e08fcc7e5f79342fac866db98a2e5d62ee2a9d17d0189d079a886abd06450cef',
      '0025_drop_legacy_chat_moves.sql': 'b823a026ca5caa3db953ad61d629b2ed0f36e305d44796b790be5b95a38b336a',
    },
    contractAllowlist: [
      // Chat identity has one immutable key; remove the unused alternate URL column and index.
      '0002_remove_chat_url_id.sql',
      // ConversationAgent now owns transcript content and revisions. Rebuild the D1
      // catalog table once to remove checkpoint columns that no runtime reads.
      '0007_builder_agent_transcript_authority.sql',
      // One conversation per GitHub project becomes one current conversation: the narrower index is
      // created first, so the rule is never unenforced, and the old one can only go.
      '0011_linked_chat_history.sql',
      // Every row is copied into a table whose two unused generation columns have defaults, so the runtime
      // that ships with it can stop naming them before a later migration drops them.
      '0015_agent_gc_generation_defaults.sql',
      // The kill switches it held were removed, and no runtime reads it.
      '0016_remove_runtime_controls.sql',
      // The transcript and cleanup-candidate generation columns, unnamed since the release before.
      '0017_drop_generation_columns.sql',
      // Tables and columns renamed to workspaces and conversations, shipped with the runtime that names them so;
      // the archive-and-continue columns no runtime reads since one workspace holds all its conversations.
      '0019_workspaces_and_conversations.sql',
      // Clone tokens, recorded by no runtime since the release before, which revoked every one still recorded.
      '0021_drop_clone_tokens.sql',
      // Which chats from before pi-durable had moved into their transcripts, unnamed since the release before.
      '0025_drop_legacy_chat_moves.sql',
    ],
  },
  {
    directory: 'template/migrations',
    // The starter's placeholder. A project's copy is its own once seeded, so a change here (as to its
    // comment, when each project's databases came to outlive its revisions) reaches only new projects.
    checksums: {
      '0001_app_data.sql': 'e4fbb51e181315da68082613a0c17936cdaf9887a151c435b7a56faf8a8cf346',
    },
    contractAllowlist: [],
  },
  {
    directory: 'template/agent-security-migrations',
    checksums: {
      '0001_agent_security.sql': 'cc62c34bcfb5e176155e371a099d000679ae69877facf252fe3d3c7e1190fbeb',
    },
    contractAllowlist: [],
  },
];

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function stripSqlCommentsAndLiterals(sql) {
  let output = '';
  let state = 'normal';

  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    const next = sql[index + 1];

    if (state === 'line-comment') {
      if (character === '\n') {
        state = 'normal';
        output += '\n';
      } else {
        output += ' ';
      }
      continue;
    }
    if (state === 'block-comment') {
      if (character === '*' && next === '/') {
        output += '  ';
        index += 1;
        state = 'normal';
      } else {
        output += character === '\n' ? '\n' : ' ';
      }
      continue;
    }
    if (state !== 'normal') {
      const terminator =
        state === 'single-quote' ? "'" : state === 'double-quote' ? '"' : state === 'backtick' ? '`' : ']';
      if (character === terminator) {
        if (state !== 'bracket' && next === terminator) {
          output += '  ';
          index += 1;
        } else {
          output += ' ';
          state = 'normal';
        }
      } else {
        output += character === '\n' ? '\n' : ' ';
      }
      continue;
    }

    if (character === '-' && next === '-') {
      output += '  ';
      index += 1;
      state = 'line-comment';
    } else if (character === '/' && next === '*') {
      output += '  ';
      index += 1;
      state = 'block-comment';
    } else if (character === "'") {
      output += ' ';
      state = 'single-quote';
    } else if (character === '"') {
      output += ' ';
      state = 'double-quote';
    } else if (character === '`') {
      output += ' ';
      state = 'backtick';
    } else if (character === '[') {
      output += ' ';
      state = 'bracket';
    } else {
      output += character;
    }
  }

  return output;
}

function topLevelTokens(statement) {
  const tokens = [];
  let depth = 0;
  for (const match of statement.matchAll(/[A-Za-z_]+|[()]/g)) {
    const value = match[0].toUpperCase();
    if (value === '(') {
      depth += 1;
    } else if (value === ')') {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0) {
      tokens.push(value);
    }
  }
  return tokens;
}

function hasUnboundedMutation(statement, mutation) {
  const tokens = topLevelTokens(statement);
  const mutationIndex = tokens.indexOf(mutation);
  return mutationIndex !== -1 && !tokens.slice(mutationIndex + 1).includes('WHERE');
}

export function findUnsafeD1MigrationOperations(sql) {
  const sanitized = stripSqlCommentsAndLiterals(sql);
  const operations = new Set();

  if (/\bDROP\s+(?:TABLE|INDEX|VIEW|TRIGGER)\b/i.test(sanitized)) {
    operations.add('DROP removes schema in place');
  }
  if (/\bALTER\s+TABLE\b[^;]*\bRENAME\s+(?:TO|COLUMN)\b/i.test(sanitized)) {
    operations.add('ALTER TABLE RENAME rewrites schema in place');
  }
  if (/\bALTER\s+TABLE\b[^;]*\bDROP\s+(?:COLUMN|CONSTRAINT)\b/i.test(sanitized)) {
    operations.add('ALTER TABLE DROP removes schema in place');
  }
  if (/\b(?:INSERT\s+OR\s+REPLACE|REPLACE)\s+INTO\b/i.test(sanitized)) {
    operations.add('REPLACE can delete conflicting rows');
  }
  if (/\bPRAGMA\s+(?:main\.)?writable_schema\b/i.test(sanitized)) {
    operations.add('PRAGMA writable_schema bypasses schema safety');
  }
  if (/\bPRAGMA\s+(?:main\.)?foreign_keys\s*=\s*(?:OFF|0)\b/i.test(sanitized)) {
    operations.add('PRAGMA foreign_keys = OFF bypasses referential integrity');
  }

  for (const statement of sanitized.split(';')) {
    if (hasUnboundedMutation(statement, 'UPDATE')) {
      operations.add('UPDATE without a top-level WHERE rewrites every row');
    }
    if (hasUnboundedMutation(statement, 'DELETE')) {
      operations.add('DELETE without a top-level WHERE removes every row');
    }
  }

  return [...operations];
}

export function findD1MigrationSafetyErrors(migrations, options) {
  const { directory, checksums, contractAllowlist = [] } = options;
  const errors = [];
  const byName = new Map(migrations.map((migration) => [migration.name, migration.content]));

  for (const [name, expectedDigest] of Object.entries(checksums)) {
    const content = byName.get(name);
    if (content === undefined) {
      errors.push(`${directory}/${name} is checksum-tracked D1 migration history and must not be removed.`);
    } else if (sha256(content) !== expectedDigest) {
      errors.push(
        `${directory}/${name} is checksum-tracked D1 migration history and must remain immutable; add a new additive migration instead.`,
      );
    }
  }

  const versioned = [];
  for (const migration of migrations) {
    const match = migrationNamePattern.exec(migration.name);
    if (!match) {
      errors.push(`${directory}/${migration.name} must use the NNNN_lowercase_name.sql migration format.`);
      continue;
    }
    if (!Object.hasOwn(checksums, migration.name)) {
      errors.push(`${directory}/${migration.name} must have an exact SHA-256 checksum entry before it can ship.`);
    }
    versioned.push({ ...migration, version: Number.parseInt(match[1], 10) });
  }

  versioned.sort((left, right) => left.version - right.version || left.name.localeCompare(right.name));
  let expectedVersion = 1;
  for (const migration of versioned) {
    if (migration.version !== expectedVersion) {
      errors.push(
        `${directory}/${migration.name} must be migration ${String(expectedVersion).padStart(4, '0')} so D1 history stays contiguous.`,
      );
      expectedVersion = migration.version;
    }
    expectedVersion += 1;
    const unsafeOperations = findUnsafeD1MigrationOperations(migration.content);
    if (!contractAllowlist.includes(migration.name)) {
      for (const operation of unsafeOperations) {
        errors.push(
          `${directory}/${migration.name} is not expand/contract safe: ${operation}; stage the additive replacement before a separately reviewed contract exception.`,
        );
      }
    } else if (unsafeOperations.length === 0) {
      errors.push(`${directory}/${migration.name} has an unnecessary contract allowlist entry; remove the exception.`);
    }
  }

  for (const name of contractAllowlist) {
    if (!Object.hasOwn(checksums, name) || !byName.has(name)) {
      errors.push(
        `${directory}/${name} contract allowlist entry must reference an existing checksum-tracked migration.`,
      );
    }
  }

  return errors;
}

function readMigrations(repositoryRoot, directory) {
  const path = resolve(repositoryRoot, directory);
  return readdirSync(path)
    .filter((name) => name.endsWith('.sql'))
    .map((name) => ({ name, content: readFileSync(resolve(path, name), 'utf8') }));
}

export function verifyD1MigrationSafety(repositoryRoot = rootDir) {
  return migrationPolicies.flatMap(({ directory, checksums, contractAllowlist }) =>
    findD1MigrationSafetyErrors(readMigrations(repositoryRoot, directory), { directory, checksums, contractAllowlist }),
  );
}

runVerifierIfMain(import.meta.url, verifyD1MigrationSafety);
