// Fake adapter that crashes before ACP initialize. Used to prove the bridge
// classifies pre-prompt startup failures as exit 3 so auto can fall back to CLI.
throw new Error('fake adapter bootstrap failure')
