Verify that an implementation matches the change artifacts (specs, tasks, design).

**Input**: Optionally specify a change name after `/specseal:verify` (e.g., `/specseal:verify add-auth`). If omitted, check if it can be inferred from conversation context; if it is still vague or ambiguous, step 1 asks the user.

**Prerequisites**: This skill requires the `specseal` CLI. If any `specseal` command fails with "command not found" or similar, report the error and STOP.

