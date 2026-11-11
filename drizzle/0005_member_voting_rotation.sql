-- Состав комиссии: «Право голоса» и «Участвует в автоматическом распределении» (как в листе «Состав Комиссии»).
ALTER TABLE users ADD COLUMN IF NOT EXISTS voting_right boolean NOT NULL DEFAULT true;
--> statement-breakpoint
ALTER TABLE users ADD COLUMN IF NOT EXISTS in_rotation boolean NOT NULL DEFAULT true;
