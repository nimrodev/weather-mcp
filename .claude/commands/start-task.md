Using the Atlassian MCP tools:

1. Search for the top "To Do" task in the "My Software Team" Jira project using JQL: `project = "My Software Team" AND status = "To Do" ORDER BY created ASC` with cloudId `b3ebd7ef-bc94-479d-813c-3b6a8adf8498`. Take only the first result.

2. Assign it to account ID `5c6dc337cff26405c30af5c6` using editJiraIssue.

3. Get available transitions and move it to "In Progress" using transitionJiraIssue.

4. Create a git branch named `TICKET-ID/short-description` where TICKET-ID is the Jira key (e.g. KAN-2) and short-description is a 2-4 word kebab-case slug of the ticket summary. Example: `git checkout -b KAN-2/get-extreme-day`. Make sure you're branching from main: `git checkout main && git pull && git checkout -b KAN-2/short-description`.

5. Read the task summary and description, then implement it fully using available tools.

6. Commit all changes with a message referencing the ticket: `git add -A && git commit -m "KAN-2: <short summary of what was done>"`.

7. Push the branch: `git push -u origin HEAD`.

8. After the push, the jira-push-reviewer skill will run automatically (triggered by the hook). Wait for it to complete and read its verdict from the output.

9. If the verdict is **PASS**, transition the Jira ticket to "In Review" using transitionJiraIssue (transition ID `31`). If the verdict is **NEEDS ATTENTION** or **FAIL**, leave the ticket in "In Progress" and report the gaps to the user.

10. Report what was done with a link to the Jira issue.
