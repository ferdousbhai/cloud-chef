-- Every chat from before pi-durable has moved into its transcript, and the release before stopped naming the table
-- that tracked those moves. Nothing reads or writes it.
DROP TABLE legacy_chat_moves;
