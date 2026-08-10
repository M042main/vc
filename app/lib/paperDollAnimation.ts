export * from "./paperDollCharacterStore";
export * from "./paperDollMotion";

import {
  createPaperDollArtworkUrl,
  type PaperDollArtworkUrl,
  type PaperDollCharacterStore,
  type SavedPaperDollCharacter,
} from "./paperDollCharacterStore";
import {
  getPaperDollMotionPreset,
  type PaperDollMotionPlayer,
} from "./paperDollMotion";

export interface RestorePaperDollPlaybackOptions {
  autoplay?: boolean;
}

export interface RestoredPaperDollPlayback<TRig = unknown> {
  character: SavedPaperDollCharacter<TRig>;
  /** Source URL that can be passed directly to PaperDollStage's artwork prop. */
  artwork: PaperDollArtworkUrl;
}

/**
 * Loads one saved character and configures a motion player with its preferred
 * preset, speed, and loop setting. The caller owns `artwork.revoke()`.
 */
export async function restorePaperDollPlayback<TRig>(
  store: PaperDollCharacterStore<TRig>,
  player: PaperDollMotionPlayer,
  characterId: string,
  options: RestorePaperDollPlaybackOptions = {},
): Promise<RestoredPaperDollPlayback<TRig>> {
  const character = await store.get(characterId);
  if (!character) throw new Error("저장한 캐릭터를 찾지 못했습니다.");

  const clip = getPaperDollMotionPreset(character.playback.presetId);
  player.setPlaybackRate(character.playback.playbackRate);
  player.load(clip, {
    autoplay: options.autoplay,
    loop: character.playback.loop,
  });

  return {
    character,
    artwork: createPaperDollArtworkUrl(character.artwork),
  };
}
