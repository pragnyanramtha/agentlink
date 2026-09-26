import { randomInt, scryptSync } from "node:crypto";
import { teamDecrypt, teamEncrypt } from "./crypto.ts";

/**
 * Short invite codes ("tiger-lamp-orbit-sun-42", ~38 bits). The relay only stores a lookup id and
 * the full invite encrypted under a key, both derived from the code with scrypt, so a stolen relay
 * database cannot be brute-forced offline in useful time; a code works once and expires quickly.
 */
// 256 short, distinct words: each word is 8 bits.
const WORDS = (
  "able acid aged also army away baby back bake ball band bank barn base bath bead beam bean bear beef bell belt " +
  "bend bird bite blue boat body bold bolt bone book boot bowl brag bran brew brim bulb bull bump bush cafe cage " +
  "cake calm camp cane card cart case cash cave cell chef chip city clam clay clip club coal coat code coin cola " +
  "cold comb cone cook cool cord corn cove crab crew crop crow cube curl dart dash dawn deck deer desk dial dice " +
  "dish dock dome door dove drum duck dune dust echo edge envy epic fair fawn fern figs film fire fish flag flax " +
  "flip foam fog folk font fork fort frog fuel gale game gate gear gift glow glue goat gold golf gong gown grid " +
  "gull hail half hall harp hawk heat herb hike hill hive holy hood hook horn hose hush icon idea inch iris iron " +
  "item jade jam jazz jeep jet jury keel kelp kind king kite kiwi knot lace lake lamb lamp land lark lava lawn " +
  "leaf lens lily lime link lion loaf loft loom lynx mango maple mask mast maze meal mesa mile milk mint moat mole " +
  "moon moss moth mule nest newt node nook note oak oar oasis ocean olive onyx opal orbit otter oven owl pace page " +
  "palm park path peak pear pier pine plum pond pony pool port quail quest quilt raft rain ramp reef rice ring " +
  "river road robe rock roof rose ruby rust sage sail salt sand seal seed shell ship silk sky sled slug snow sofa " +
  "soup spark star stem stone sun swan tent tide tiger toad tulip vine wave wolf yarn zinc"
)
  .split(" ")
  .slice(0, 256);

if (new Set(WORDS).size !== 256) throw new Error("invite word list must have 256 unique words");

export const INVITE_CODE_RE = /^[a-z]+-[a-z]+-[a-z]+-[a-z]+-\d{2}$/;

export function newInviteCode(): string {
  const words = Array.from({ length: 4 }, () => WORDS[randomInt(256)] as string);
  return `${words.join("-")}-${String(randomInt(100)).padStart(2, "0")}`;
}

export function normalizeCode(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, "-");
}

const KDF = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/** Lookup id the relay stores the invite under. */
export function codeId(code: string): string {
  return scryptSync(normalizeCode(code), "agentlink/invite-code/id/v1", 16, KDF).toString(
    "base64url",
  );
}

function codeKey(code: string): string {
  return scryptSync(normalizeCode(code), "agentlink/invite-code/key/v1", 32, KDF).toString(
    "base64url",
  );
}

export function sealInvite(code: string, invite: string): { nonce: string; ct: string } {
  return teamEncrypt(codeKey(code), Buffer.from(invite), "agentlink/invite-code");
}

export function openInvite(code: string, box: { nonce: string; ct: string }): string {
  return teamDecrypt(codeKey(code), box, "agentlink/invite-code").toString("utf8");
}
