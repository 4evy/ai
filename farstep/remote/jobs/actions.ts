export const MAX_SEQUENCE_STEPS = 20;

export const JOB_ACTIONS = {
  list: { approval: "read", waitSeconds: 0 },
  status: { approval: "read", waitSeconds: 0 },
  logs: { approval: "read", waitSeconds: 0 },
  wait: { approval: "read", waitSeconds: 30 },
  receipt: { approval: "read", waitSeconds: 0 },
  sequence: { approval: "exec", waitSeconds: 0.2 },
  input: { approval: "exec", waitSeconds: 0.2 },
  reply: { approval: "exec", waitSeconds: 0.2 },
  password: { approval: "exec", waitSeconds: 0.2 },
  keys: { approval: "exec", waitSeconds: 0.2 },
  screen: { approval: "read", waitSeconds: 0 },
  resize: { approval: "exec", waitSeconds: 0.2 },
  interrupt: { approval: "exec", waitSeconds: 0 },
  stop: { approval: "exec", waitSeconds: 0 },
  force: { approval: "exec", waitSeconds: 0 },
  mode: { approval: "exec", waitSeconds: 0 },
  cancel: { approval: "exec", waitSeconds: 0 },
} as const;
