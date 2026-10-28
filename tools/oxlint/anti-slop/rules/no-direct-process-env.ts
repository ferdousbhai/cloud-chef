import { defineRule } from "@oxlint/plugins";

export const noDirectProcessEnvRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow direct process.env usage; Workers read runtime values from their env bindings.",
    },
    messages: {
      noDirectProcessEnv:
        "Direct process.env usage is not allowed. Read runtime values from Cloudflare Worker env bindings with getOptionalBinding(env, NAME); keep process.env limited to production deploy scripts.",
    },
  },
  createOnce(context) {
    return {
      MemberExpression(node) {
        if (
          node.object.type === "Identifier" &&
          node.object.name === "process" &&
          node.property.type === "Identifier" &&
          node.property.name === "env"
        ) {
          context.report({ node, messageId: "noDirectProcessEnv" });
        }
      },
    };
  },
});
