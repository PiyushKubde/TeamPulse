# ViaSocket plan (TeamPulse)

| app | action or trigger (key, version) | key of `inputData` | who supplies it | when |
| --- | --- | --- | --- | --- |
| slack | `Send_Message` v107 (action id `row1jrbor`) | `destination.channel_id` | the manager, from their channel list | once, when setting up an automation or sharing a task |
| slack | `Send_Message` v107 | `markdown_content` | TeamPulse (task / weekly summary text) | per run |
| gmail | Send Email V55 (action id `rowogelpy0h6`) | `to` | TeamPulse: the assignee's email (New Task Notification) or the address the manager chose (Weekly Report) | per run / once |
| gmail | Send Email V55 | `subject`, `messageBody`, `fromName` | TeamPulse | per run |
| github, google-calendar, google-sheets | (Advanced builder) | — | the user, in ViaSocket's screens | when they build a flow |

Who picks the action: TeamPulse's code, from the automation the manager configured. Runs happen on the server with the configuring manager's own connection; `script_id`s are checked to belong to that user.

UNTESTED against live ViaSocket (keys not available during the build): connect popup, Slack/Gmail sends, embed mount. Tested with a fake gateway of the same shape. See docs/integrations.md.
