# The outbound call bridge

**Status: implemented, not live-tested.** Every part of this exists and is covered by tests that
run the real code paths against a simulator. No provider has ever been configured on this
deployment, so no telephone call has ever been placed. That distinction is the point of this
document — nothing below claims otherwise.

## What it is for

Reaching you when you are not looking at a screen, about a decision only you can make. That is the
whole use.

It does not read briefings aloud, it does not chase you, and it does not check in. Those are things
a notification does, at no risk of ringing a phone at three in the morning.

## What it will never do

These are refusals in code, not settings. There is nothing to turn off, and a provider
misconfigured to permit them still cannot get past `assertCallAllowed`.

- **Call anybody but you.** One number, yours, verified. A call to any other number is refused
  with `R-CB3` before anything dials.
- **Place a marketing call, or contact a third party.** There is no code path that takes a
  recipient from anywhere except your own verified number.
- **Read out a credential.** Every script is scanned before dialling (`R-CB7`). The situation
  sentence is assembled from mission titles and failure messages — text that came from a
  repository, which is somewhere other people write — so this is checked rather than trusted.
- **Run up an open-ended bill.** At most three calls a day, at most ninety seconds each, at most
  three choices, no retry loop. A call nobody answers ends with "Jarvis has changed nothing".
- **Ring during your quiet hours**, unless you asked for the call in that moment yourself.

## What a call sounds like

> This is an automated call from Jarvis, your own assistant. It will take less than a minute and
> you can hang up at any time.
>
> The nightly build has failed three times. Should Jarvis look at it now?
>
> Press one for: yes, look at it now. Press two for: no, leave it.

The identification line is word-for-word fixed. It is what separates this from the thing everybody
hangs up on, and varying it — even to sound friendlier — removes the one cue that makes it
recognisable.

Keypad is offered first because a digit is unambiguous and speech down a phone line is not. Speech
is matched against a fixed alias list; anything that matches two options, or none, is treated as
unclear and left on the screen instead. An answer this consequential is refused when it is unclear
rather than guessed at from a noisy line.

## Setting it up

Nothing here has been done on this deployment. This is the exact list.

1. **Choose a provider** that can place an outbound call and post the result back over HTTPS —
   Twilio, Vonage, Telnyx and Amazon Connect all can. Jarvis does not depend on any of them; the
   bridge talks to a `CallProvider` interface with two methods.
2. **Buy or port a number** to place calls _from_. It is never dialled by Jarvis and appears in no
   log.
3. **Verify your own number** with the provider, in E.164 form (`+447700900812`). This is the only
   number Jarvis will ever call.
4. **Set these, in `.env.local`, never in the repository:**
   - `JARVIS_CALL_PROVIDER` — the provider's name, which is what makes `configured` true.
   - `JARVIS_CALL_ACCOUNT` — the account or key id.
   - `JARVIS_CALL_SECRET` — the provider's secret. Never logged, never spoken, never rendered.
   - `JARVIS_CALL_FROM` — the number to call from, E.164.
   - `JARVIS_CALL_TO` — your verified number, E.164.
5. **Set your quiet hours** in Settings. Until you do, Jarvis assumes 22:00–08:00 and will not ring
   inside them.
6. **Write the provider adapter**: one class implementing `CallProvider` in `src/server/calls/`,
   whose `place` dials, reads the script, collects a digit or a phrase, and returns a
   `CallResponse`. Everything above and below it already exists.
7. **Test it against the provider's sandbox first.** Every provider has one, and the first real
   call should be one you were expecting.

Until step 6 exists, `CallBridge.configured` is false and every call is refused with `R-CB1`.
Readiness reports this as "no calling provider is configured, so Jarvis will never place a call",
which is the honest state and not a fault.

## How it is tested without a telephone

`CallSimulator` is a real `CallProvider`. There is no "if in test" branch anywhere in the bridge, so
the code a real provider would run is exactly the code the tests run — which is what makes
"implemented but not live-tested" an honest claim rather than a hopeful one.

What the tests prove: it refuses without a provider, refuses a number that is not yours, refuses
past the daily cap, refuses inside quiet hours, allows a call you asked for at 3am, refuses a
fourth menu option, refuses a script containing something credential-shaped _before_ dialling,
takes a keypad digit exactly, refuses ambiguous speech, treats silence as silence, and never writes
the number down unmasked.

What they cannot prove: that a real provider dials, that the audio is intelligible, that DTMF
arrives, or that the callback reaches this deployment. Those need step 7.
