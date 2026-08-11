"use client";

import { LoaderCircle, Plus, School, Trash2, UserRound } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  createClassRecord,
  deleteClassRecord,
  subscribeClassRecords,
  type ClassRecord,
} from "../lib/firebaseGallery";
import {
  clearVisitorProfile,
  createVisitorProfile,
  loadVisitorProfile,
  storeVisitorProfile,
  type VisitorProfile,
} from "../lib/visitorProfile";
import styles from "./ClassOnboarding.module.css";

export function useVisitorProfile() {
  const [profile, setProfileState] = useState<VisitorProfile | null>(null);
  const [profileReady, setProfileReady] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setProfileState(loadVisitorProfile());
      setProfileReady(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const setProfile = useCallback((nextProfile: VisitorProfile | null) => {
    if (nextProfile) {
      setProfileState(storeVisitorProfile(nextProfile));
    } else {
      clearVisitorProfile();
      setProfileState(null);
    }
  }, []);

  return { profile, profileReady, setProfile } as const;
}

export interface ClassOnboardingProps {
  profile: VisitorProfile | null;
  profileReady?: boolean;
  blocking?: boolean;
  isAdmin?: boolean;
  className?: string;
  onProfileChange: (profile: VisitorProfile | null) => void;
  onAdminRequest?: () => void;
}

function messageFrom(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function ClassOnboarding({
  profile,
  profileReady = true,
  blocking = false,
  isAdmin = false,
  className,
  onProfileChange,
  onAdminRequest,
}: ClassOnboardingProps) {
  const [classes, setClasses] = useState<ClassRecord[]>([]);
  const [classesReady, setClassesReady] = useState(false);
  const [classesError, setClassesError] = useState("");
  const [editing, setEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [profileMode, setProfileMode] = useState<"class" | "guest">("class");
  const [classIdDraft, setClassIdDraft] = useState("");
  const [profileError, setProfileError] = useState("");
  const [status, setStatus] = useState("");
  const [newClassName, setNewClassName] = useState("");
  const [classBusy, setClassBusy] = useState(false);
  const [deleteCandidateId, setDeleteCandidateId] = useState<string | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const newClassInputRef = useRef<HTMLInputElement>(null);
  const isBlocking = blocking && profileReady && !profile;

  useEffect(() => {
    let active = true;
    let unsubscribe: () => void = () => undefined;
    const timer = window.setTimeout(() => {
      if (!active) return;
      unsubscribe = subscribeClassRecords({
        onData: (nextClasses) => {
          if (!active) return;
          setClasses(nextClasses);
          setClassesReady(true);
          setClassesError("");
        },
        onError: (error) => {
          if (!active) return;
          setClassesReady(true);
          setClassesError(messageFrom(error, "학급 목록을 불러오지 못했습니다."));
        },
      });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!profileReady || profile || editing) return;
    const timer = window.setTimeout(() => setEditing(true), 0);
    return () => window.clearTimeout(timer);
  }, [editing, profile, profileReady]);

  useEffect(() => {
    if (!classesReady || !profile || profile.guest || !profile.classId) return;
    const activeClass = classes.find((item) => item.id === profile.classId);
    if (activeClass) {
      if (activeClass.name === profile.className) return;
      const timer = window.setTimeout(() => {
        onProfileChange(
          storeVisitorProfile({ ...profile, className: activeClass.name }),
        );
      }, 0);
      return () => window.clearTimeout(timer);
    }
    const timer = window.setTimeout(() => {
      clearVisitorProfile();
      onProfileChange(null);
      setEditing(true);
      setStatus("선택했던 학급이 없어져 프로필을 다시 설정해 주세요.");
    }, 0);
    return () => window.clearTimeout(timer);
  }, [classes, classesReady, onProfileChange, profile]);

  useEffect(() => {
    if (!editing) return;
    const timer = window.setTimeout(() => {
      setNameDraft(profile?.name ?? "");
      setProfileMode(profile?.guest ? "guest" : "class");
      setClassIdDraft(profile?.classId ?? classes[0]?.id ?? "");
      setProfileError("");
    }, 0);
    return () => window.clearTimeout(timer);
  }, [classes, editing, profile]);

  useEffect(() => {
    if (!isBlocking) return;
    const focusTimer = window.setTimeout(() => {
      setEditing(true);
    }, 0);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        return;
      }
      if (event.key !== "Tab") return;
      const controls = panelRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (!controls?.length) return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isBlocking]);

  useEffect(() => {
    if (!isBlocking || !editing || isAdmin) return;
    const timer = window.setTimeout(() => nameInputRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [editing, isAdmin, isBlocking]);

  useEffect(() => {
    if (!isBlocking || !isAdmin) return;
    const timer = window.setTimeout(() => newClassInputRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [isAdmin, isBlocking]);

  const selectedClass = useMemo(
    () => classes.find((item) => item.id === classIdDraft) ?? null,
    [classIdDraft, classes],
  );

  const submitProfile = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      const nextProfile = createVisitorProfile({
        name: nameDraft,
        guest: profileMode === "guest",
        classId: selectedClass?.id,
        className: selectedClass?.name,
      });
      const stored = storeVisitorProfile(nextProfile);
      onProfileChange(stored);
      setEditing(false);
      setStatus(
        stored.guest
          ? "게스트로 시작했습니다. 기기 안에서는 체험할 수 있지만 클라우드 저장은 꺼집니다."
          : `${stored.className} · ${stored.name} 프로필을 저장했습니다.`,
      );
    } catch (error) {
      setProfileError(messageFrom(error, "프로필을 저장하지 못했습니다."));
    }
  };

  const createClass = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!isAdmin || classBusy) return;
    setClassBusy(true);
    setStatus("학급을 만드는 중입니다.");
    try {
      const classRecord = await createClassRecord(newClassName);
      setNewClassName("");
      setClassIdDraft(classRecord.id);
      setStatus(`${classRecord.name} 학급을 만들었습니다.`);
    } catch (error) {
      setStatus(messageFrom(error, "학급을 만들지 못했습니다."));
    } finally {
      setClassBusy(false);
    }
  };

  const deleteClass = async (classRecord: ClassRecord) => {
    if (!isAdmin || classBusy || deleteCandidateId !== classRecord.id) return;
    setClassBusy(true);
    setStatus(`${classRecord.name} 학급을 삭제하는 중입니다.`);
    try {
      await deleteClassRecord(classRecord.id);
      setDeleteCandidateId(null);
      setStatus(
        `${classRecord.name} 학급만 삭제했습니다. 기존 갤러리와 저장 작품은 유지됩니다.`,
      );
    } catch (error) {
      setStatus(messageFrom(error, "학급을 삭제하지 못했습니다."));
    } finally {
      setClassBusy(false);
    }
  };

  const panel = (
    <section
      ref={panelRef}
      className={[styles.panel, className].filter(Boolean).join(" ")}
      aria-label="방문자 프로필과 학급 설정"
      role={isBlocking ? "dialog" : undefined}
      aria-modal={isBlocking ? true : undefined}
    >
      <div className={styles.summary}>
        <span className={styles.profileIcon} aria-hidden="true">
          {profile?.guest ? <UserRound size={18} /> : <School size={18} />}
        </span>
        <div>
          <span>활성 프로필</span>
          <strong>
            {!profileReady
              ? "불러오는 중"
              : profile
                ? `${profile.className} · ${profile.name}`
                : "프로필을 설정해 주세요"}
          </strong>
        </div>
        <button
          type="button"
          onClick={() => setEditing((value) => (isBlocking ? true : !value))}
          disabled={isBlocking}
        >
          {isBlocking ? "설정 필요" : editing ? "닫기" : profile ? "변경" : "시작하기"}
        </button>
      </div>

      {editing ? (
        <form className={styles.profileForm} onSubmit={submitProfile}>
          <label>
            이름
            <input
              ref={nameInputRef}
              value={nameDraft}
              onChange={(event) => setNameDraft(event.target.value)}
              maxLength={24}
              autoComplete="nickname"
              placeholder="예: 박근석"
            />
          </label>
          <fieldset>
            <legend>참여 방식</legend>
            <label>
              <input
                type="radio"
                name="profile-mode"
                checked={profileMode === "class"}
                onChange={() => setProfileMode("class")}
              />
              학급으로 참여
            </label>
            <label>
              <input
                type="radio"
                name="profile-mode"
                checked={profileMode === "guest"}
                onChange={() => setProfileMode("guest")}
              />
              게스트 체험
            </label>
          </fieldset>
          {profileMode === "class" ? (
            <label>
              학급
              <select
                value={classIdDraft}
                onChange={(event) => setClassIdDraft(event.target.value)}
                disabled={!classesReady || classes.length === 0}
              >
                <option value="">학급 선택</option>
                {classes.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p className={styles.guestNotice}>
              게스트는 트래킹과 다운로드를 체험할 수 있지만 갤러리·작품 클라우드
              저장은 사용할 수 없습니다.
            </p>
          )}
          {profileError ? <span className={styles.error} role="alert">{profileError}</span> : null}
          <button className={styles.primaryButton} type="submit">
            프로필 저장
          </button>
        </form>
      ) : null}

      {isBlocking && !isAdmin && onAdminRequest ? (
        <button
          type="button"
          className={styles.adminRequestButton}
          onClick={onAdminRequest}
        >
          관리자 설정
        </button>
      ) : null}

      {isAdmin ? (
        <div className={styles.adminArea}>
          <div>
            <strong>학급 관리</strong>
            <span>학급 삭제는 갤러리 사진과 저장 작품을 삭제하지 않습니다.</span>
          </div>
          <form onSubmit={(event) => void createClass(event)}>
            <label htmlFor="new-class-name">새 학급 이름</label>
            <input
              ref={newClassInputRef}
              id="new-class-name"
              value={newClassName}
              onChange={(event) => setNewClassName(event.target.value)}
              maxLength={40}
            />
            <button type="submit" disabled={classBusy || !newClassName.trim()}>
              {classBusy ? <LoaderCircle className={styles.spinner} size={16} /> : <Plus size={16} />}
              만들기
            </button>
          </form>
          <ul>
            {classes.map((item) => (
              <li key={item.id}>
                <span>{item.name}</span>
                {deleteCandidateId === item.id ? (
                  <span className={styles.deleteConfirm}>
                    <button
                      type="button"
                      onClick={() => void deleteClass(item)}
                      disabled={classBusy}
                    >
                      삭제 확인
                    </button>
                    <button
                      type="button"
                      onClick={() => setDeleteCandidateId(null)}
                      disabled={classBusy}
                    >
                      취소
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => setDeleteCandidateId(item.id)}
                    disabled={classBusy}
                    aria-label={`${item.name} 학급 삭제 선택`}
                  >
                    <Trash2 size={15} aria-hidden="true" /> 삭제
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {classesError ? <p className={styles.error} role="alert">{classesError}</p> : null}
      <p className={styles.status} role="status" aria-live="polite">{status}</p>
    </section>
  );

  return isBlocking ? (
    <div className={styles.blockingBackdrop}>{panel}</div>
  ) : (
    panel
  );
}

export default ClassOnboarding;
