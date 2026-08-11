# Assisted Password Recovery

This runbook is the temporary password-recovery process until the Cloud account
service provides a self-service, email-token-based reset flow.

## User Request

1. Ask the user to select **Forgot password? Contact support** on the desktop
   sign-in screen.
2. Require the request to be sent from the registered email address.
3. Never ask for the old password, another password, a full activation code,
   an API key, or a JWT.

## Ownership Verification

Verify the request using at least one server-side record in addition to the
sender address, such as the account creation record, a partially redacted
activation-code record, or a payment record. Escalate mismatches instead of
resetting the account.

## Cloud-Side Reset

The desktop repository does not store account passwords. The active client
forwards credentials to the configured Cloud service at `/api/auth/login`.
Perform the reset only in the Cloud account service:

1. Generate a unique random password with at least 20 characters.
2. Use the Cloud service's own password-hashing function or maintenance command.
   Do not store plaintext and do not construct a hash with an ad hoc SQL
   expression.
3. Revoke existing login JWTs, refresh tokens, and password-reset tokens for
   the account. Preserve account balance, transactions, activation ownership,
   and model entitlements.
4. Record the operator, account ID, verification method, and reset time in the
   security audit log. Do not record the generated password.
5. Deliver the generated password only to the verified registered email
   address. Ask the user to store it in a password manager.

If the Cloud service cannot revoke existing sessions or safely update the
password through its native hashing path, do not modify the database directly.
Escalate to the Cloud service owner.

## Completion

Confirm that the user can sign in, then close the support request without
copying credentials into tickets or chat logs. A future self-service flow
should replace this runbook with short-lived, single-use reset tokens and
mandatory session revocation.
