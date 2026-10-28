import { defineRule } from "@oxlint/plugins";

/** `bottom-4`, which common ad-blocking filters hide, standing alone in a class string. */
const AD_BLOCKED_CLASS = /bottom-4(?:\D|$)/i;

export const noAdBlockedClassRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow class names that common ad-blocking filters hide.",
    },
    messages: {
      adBlockedClass: ".bottom-4 is blocked by common ad-blocking filters; use .bottom-four instead",
    },
  },
  createOnce(context) {
    return {
      Literal(node) {
        if (typeof node.value === "string" && AD_BLOCKED_CLASS.test(node.value)) {
          context.report({ node, messageId: "adBlockedClass" });
        }
      },
    };
  },
});
