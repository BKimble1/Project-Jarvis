-- The decisions Blake made about a proposal, in his own words.
--
-- An idea arrives, I assess it and ask a few questions, and he answers them — often all at once, in
-- one message, as a list of statements rather than as replies to a list. Those answers are the most
-- valuable thing in the whole exchange: they are the scope, and they are the difference between
-- building what he agreed to and building what I guessed.
--
-- They had nowhere to live. `assumptions` is what *I* took on trust and `recommended_v1` is what I
-- suggested; neither is what he decided, and folding his decisions into either would lose the
-- distinction exactly when it matters — at "Go ahead", when the mission is written.
--
-- Stored verbatim, in the order he said them, because a decision that has been paraphrased is a
-- different decision.
ALTER TABLE "conversation_proposals" ADD COLUMN IF NOT EXISTS "answers" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
-- When the scope was last settled, so "is this final?" is answerable without reading the answers.
ALTER TABLE "conversation_proposals" ADD COLUMN IF NOT EXISTS "scope_locked_at" timestamp with time zone;
