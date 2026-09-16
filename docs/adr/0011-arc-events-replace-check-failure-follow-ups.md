# Arc events replace the check-failure follow-up for members

When a PR goes red, the GitHub poller launches a check-failure follow-up agent into the workspace. Inside an Arc that is the wrong responder. The coordinator is already deciding what each member does, and a follow-up agent working the same red commit while the coordinator dispatches its own fix puts two agents on one problem — the fan-out this poller has shipped once before.

So for a member of a live Arc, a failing PR sends one message to the coordinator instead, and the follow-up stands down. Passing and merged transitions also reach the coordinator, alongside the ordinary hooks, because they are how it learns that delegated work landed.

Standing down is conditional on the message reaching the coordinator. A live Arc (active, with a coordinator whose workspace is not archived) is a precondition, but the suppression is decided at delivery time: if the send fails, the ordinary follow-up runs as if there were no Arc. A red PR must never go unanswered because a coordinator could not be woken.

Events are deduplicated on persisted PR state transitions rather than an in-memory ledger, keyed by Arc, project, PR, kind, head SHA, and observation time. A restart with an unchanged red PR sends nothing, a PR that went red while the app was closed sends once, and the same PR number in two projects of one Arc are two events. A paused or done Arc, or one without a coordinator, keeps the poller's ordinary behaviour exactly.
