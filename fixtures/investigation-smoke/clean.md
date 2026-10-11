# Release rollout plan

This is a proposed rollout; production approval is pending. Maya Chen owns the release. Luis Ortega owns rollback.

Start at 10% of traffic. Advance to 100% only after a full 24 hours with error rate below 1%. Roll back immediately if error rate exceeds 2% for five consecutive minutes.

We will monitor error rates and communicate progress in the launch channel.
