"use client";

import { Check, LoaderCircle, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import styles from "./SavedCharacterLibrary.module.css";

export type SavedCharacterChoice = {
  id: string;
  name: string;
  artwork: string;
  updatedAt: number;
};

export interface SavedCharacterLibraryProps {
  characters: readonly SavedCharacterChoice[];
  activeId: string | null;
  busy?: boolean;
  onSelect: (id: string) => void;
  onCreateNew: () => void;
  onDelete: (id: string) => void | Promise<void>;
}

const MAX_CHARACTERS = 3;

export function SavedCharacterLibrary({
  characters,
  activeId,
  busy = false,
  onSelect,
  onCreateNew,
  onDelete,
}: SavedCharacterLibraryProps) {
  const [deleteCandidate, setDeleteCandidate] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const atLimit = characters.length >= MAX_CHARACTERS;

  const confirmDelete = async (id: string) => {
    if (deletingId) return;
    setDeletingId(id);
    setDeleteError("");
    try {
      await onDelete(id);
      setDeleteCandidate(null);
    } catch (error) {
      setDeleteError(
        error instanceof Error && error.message
          ? error.message
          : "캐릭터를 삭제하지 못했습니다.",
      );
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <section className={styles.library} aria-labelledby="saved-character-title">
      <div className={styles.heading}>
        <div>
          <span>MY CHARACTERS</span>
          <h2 id="saved-character-title">내가 만든 캐릭터</h2>
          <p>최대 3개까지 저장하고 다시 불러오거나 무대에서 교체할 수 있어요.</p>
        </div>
        <strong>{characters.length} / {MAX_CHARACTERS}</strong>
      </div>

      <div className={styles.grid}>
        {characters.map((character) => {
          const active = character.id === activeId;
          const confirming = deleteCandidate === character.id;
          return (
            <article key={character.id} className={styles.card} data-active={active}>
              <button
                type="button"
                className={styles.previewButton}
                onClick={() => onSelect(character.id)}
                disabled={busy || deletingId !== null}
                aria-pressed={active}
              >
                <span className={styles.preview}>
                  {/* eslint-disable-next-line @next/next/no-img-element -- local PNG data URL */}
                  <img src={character.artwork} alt="" />
                </span>
                <span className={styles.cardCopy}>
                  <strong>{character.name}</strong>
                  <small>{active ? "편집 중" : "불러오기"}</small>
                </span>
                {active ? <Check size={17} aria-hidden="true" /> : null}
              </button>

              {confirming ? (
                <span className={styles.confirmActions}>
                  <button
                    type="button"
                    onClick={() => void confirmDelete(character.id)}
                    disabled={deletingId !== null}
                  >
                    {deletingId === character.id ? (
                      <LoaderCircle className={styles.spinner} size={15} aria-hidden="true" />
                    ) : null}
                    삭제 확인
                  </button>
                  <button
                    type="button"
                    onClick={() => setDeleteCandidate(null)}
                    disabled={deletingId !== null}
                  >
                    취소
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className={styles.deleteButton}
                  onClick={() => setDeleteCandidate(character.id)}
                  disabled={busy || deletingId !== null}
                  aria-label={`${character.name} 삭제`}
                >
                  <Trash2 size={15} aria-hidden="true" /> 삭제
                </button>
              )}
            </article>
          );
        })}

        <button
          type="button"
          className={styles.newCard}
          onClick={onCreateNew}
          disabled={atLimit || busy}
          aria-describedby={atLimit ? "saved-character-limit" : undefined}
        >
          <Plus size={22} aria-hidden="true" />
          <strong>새 캐릭터</strong>
          <span>{atLimit ? "3개를 모두 사용 중" : "빈 캔버스에서 시작"}</span>
        </button>
      </div>
      <p id="saved-character-limit" className={styles.limitMessage} aria-live="polite">
        {atLimit ? "새로 만들려면 기존 캐릭터 하나를 삭제해 주세요." : ""}
      </p>
      {deleteError ? <p className={styles.error} role="alert">{deleteError}</p> : null}
    </section>
  );
}

export default SavedCharacterLibrary;
