# tiny-node-failing

End-to-end fixture for the code engine's repair policy. Like `tiny-node`, it has no dependencies, so `npm test` runs
in the sandbox without an install step. Unlike it, one test always fails: `subtract` has a planted bug. The model
stub's edits only add a comment, so they never fix it, which makes the outcome of a run deterministic: the tests fail
after every attempt, and the number of attempts shows exactly what the repair policy allowed.
