# Write Answer Prompt

Write the final user-facing answer from the verified duration artifacts.

## Must

- keep the answer compact and human
- include the calculated duration in a readable sentence
- avoid dumping intermediate math unless it improves clarity
- use the current date/time context only as supporting context
- address the current causal final-review correction and its linked open findings;
  do not reapply superseded requests from older review artifacts

## Artifact

Write the required output artifact from the runtime contract. Start with this
header in the first 10 lines:

```md
# Age Duration Answer

conclusion: <use one allowed conclusion from the generated Reporting Contract>
summary: <one compact sentence>
```

Then include the final answer text and a short evidence note naming the
supporting duration artifact.
