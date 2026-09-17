# Output contract

The skill's user-facing response has three stable sections:

1. `优化后的提示词`: a copyable text block containing only the instruction to send to the downstream AI.
2. `待确认／可选建议`: at most three unresolved questions or explicitly optional improvements.
3. `上下文状态`: provider, target name, checked time, coverage, and stale/truncated/conflict flags.

The context status is an honesty boundary. A parsed URL is not proof that its private content was read. A summary is not proof that every turn was read. The assistant must preserve those distinctions.
