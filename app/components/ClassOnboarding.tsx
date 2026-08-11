"use client";

import {
  LoaderCircle,
  LogOut,
  Pencil,
  Plus,
  School,
  Sparkles,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  createClassRecord,
  deleteClassRecord,
  setClassAiEnabled,
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

  useEffect(() => {
    if (!profileReady || !profile || profile.guest || !profile.classId) return;
    let active = true;
    let unsubscribe: () => void = () => undefined;
    const timer = window.setTimeout(() => {
      if (!active) return;
      unsubscribe = subscribeClassRecords({
        onData: (classes) => {
          if (!active) return;
          const currentClass = classes.find((item) => item.id === profile.classId);
          if (!currentClass) {
            setProfile(null);
            return;
          }
          if (currentClass.name !== profile.className) {
            setProfile({ ...profile, className: currentClass.name });
          }
        },
        // A failed read must never be mistaken for a deleted class.
        onError: () => undefined,
      });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, [profile, profileReady, setProfile]);

  return { profile, profileReady, setProfile } as const;
}

export interface VisitorProfileActionsProps {
  profile: VisitorProfile;
  onProfileChange: (profile: VisitorProfile | null) => void;
  disabled?: boolean;
}

export function VisitorProfileActions({
  profile,
  onProfileChange,
  disabled = false,
}: VisitorProfileActionsProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState(profile.name);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const inputId = useId();
  const errorId = useId();

  const closeDialog = useCallback((restoreFocus = true) => {
    setDialogOpen(false);
    setError("");
    if (restoreFocus) {
      window.setTimeout(() => triggerRef.current?.focus(), 0);
    }
  }, []);

  const openDialog = () => {
    if (disabled) return;
    setNameDraft(profile.name);
    setError("");
    setStatus("");
    setDialogOpen(true);
  };

  useEffect(() => {
    if (!dialogOpen) return;
    const focusTimer = window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeDialog();
        return;
      }
      if (event.key !== "Tab") return;
      const controls = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
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
  }, [closeDialog, dialogOpen]);

  const saveName = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (disabled) return;
    try {
      const nextProfile = createVisitorProfile({ ...profile, name: nameDraft });
      onProfileChange(nextProfile);
      setStatus(`${nextProfile.name} 이름으로 변경했습니다.`);
      closeDialog();
    } catch (saveError) {
      setError(messageFrom(saveError, "이름을 변경하지 못했습니다."));
      inputRef.current?.focus();
    }
  };

  const logout = () => {
    if (disabled) return;
    setDialogOpen(false);
    setStatus("");
    onProfileChange(null);
  };

  return (
    <div
      className={styles.headerProfileActions}
      aria-label="학생 프로필"
      aria-busy={disabled}
    >
      <div className={styles.profileIdentity} title={`${profile.className} · ${profile.name}`}>
        <span className={styles.profileIdentityIcon} aria-hidden="true">
          {profile.guest ? <UserRound size={16} /> : <School size={16} />}
        </span>
        <span>
          <small>{profile.className}</small>
          <span className={styles.profileSeparator} aria-hidden="true">·</span>
          <strong>{profile.name}</strong>
        </span>
      </div>
      <button
        ref={triggerRef}
        className={styles.headerActionButton}
        type="button"
        onClick={openDialog}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-label="학생 이름 변경"
      >
        <Pencil size={15} aria-hidden="true" />
        <span>변경</span>
      </button>
      <button
        className={[styles.headerActionButton, styles.logoutButton].join(" ")}
        type="button"
        onClick={logout}
        disabled={disabled}
        aria-label="학생 프로필 로그아웃"
      >
        <LogOut size={16} aria-hidden="true" />
        <span>학생 로그아웃</span>
      </button>
      <span className={styles.srOnly} role="status" aria-live="polite">
        {status}
      </span>

      {dialogOpen ? (
        <div className={styles.profileDialogBackdrop}>
          <section
            ref={dialogRef}
            className={styles.profileDialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={descriptionId}
            tabIndex={-1}
          >
            <button
              className={styles.profileDialogClose}
              type="button"
              onClick={() => closeDialog()}
              aria-label="이름 변경 창 닫기"
            >
              <X size={18} aria-hidden="true" />
            </button>
            <span className={styles.profileDialogIcon} aria-hidden="true">
              <UserRound size={22} />
            </span>
            <h2 id={titleId}>학생 이름 변경</h2>
            <p id={descriptionId}>
              <strong>{profile.className}</strong> 정보는 그대로 유지되고 이름만
              변경됩니다.
            </p>
            <form onSubmit={saveName}>
              <label htmlFor={inputId}>이름</label>
              <input
                ref={inputRef}
                id={inputId}
                value={nameDraft}
                onChange={(event) => {
                  setNameDraft(event.target.value);
                  if (error) setError("");
                }}
                maxLength={24}
                autoComplete="nickname"
                disabled={disabled}
                aria-invalid={Boolean(error)}
                aria-describedby={error ? errorId : descriptionId}
              />
              {error ? (
                <span id={errorId} className={styles.error} role="alert">
                  {error}
                </span>
              ) : null}
              <div className={styles.profileDialogActions}>
                <button type="button" onClick={() => closeDialog()}>
                  취소
                </button>
                <button type="submit" disabled={disabled}>이름 저장</button>
              </div>
            </form>
          </section>
        </div>
      ) : null}
    </div>
  );
}

export interface ClassOnboardingProps {
  profile: VisitorProfile | null;
  profileReady?: boolean;
  blocking?: boolean;
  isAdmin?: boolean;
  adminOnly?: boolean;
  className?: string;
  blockingModalControl?: ReactNode;
  onProfileChange: (profile: VisitorProfile | null) => void;
}

function messageFrom(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function ClassOnboarding({
  profile,
  profileReady = true,
  blocking = false,
  isAdmin = false,
  adminOnly = false,
  className,
  blockingModalControl,
  onProfileChange,
}: ClassOnboardingProps) {
  const [classes, setClasses] = useState<ClassRecord[]>([]);
  const [classesReady, setClassesReady] = useState(false);
  const [classesLoadedSuccessfully, setClassesLoadedSuccessfully] =
    useState(false);
  const [classesError, setClassesError] = useState("");
  const [editing, setEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
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
          setClassesLoadedSuccessfully(true);
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
    if (
      !classesLoadedSuccessfully ||
      !profile ||
      profile.guest ||
      !profile.classId
    ) return;
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
  }, [classes, classesLoadedSuccessfully, onProfileChange, profile]);

  useEffect(() => {
    if (!editing) return;
    const timer = window.setTimeout(() => {
      setNameDraft(profile?.name ?? "");
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

  const saveProfile = (guest: boolean) => {
    try {
      const nextProfile = createVisitorProfile({
        name: nameDraft,
        guest,
        classId: guest ? undefined : selectedClass?.id,
        className: guest ? undefined : selectedClass?.name,
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

  const submitClassProfile = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    saveProfile(false);
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

  const toggleClassAi = async (classRecord: ClassRecord) => {
    if (!isAdmin || classBusy) return;
    const nextEnabled = !classRecord.aiEnabled;
    setClassBusy(true);
    setStatus(
      `${classRecord.name} 학급의 AI 이미지 생성을 ${nextEnabled ? "켜는" : "끄는"} 중입니다.`,
    );
    try {
      await setClassAiEnabled(classRecord.id, nextEnabled);
      setStatus(
        `${classRecord.name} 학급의 AI 이미지 생성을 ${nextEnabled ? "켰습니다." : "껐습니다."}`,
      );
    } catch (error) {
      setStatus(messageFrom(error, "AI 이미지 생성 설정을 변경하지 못했습니다."));
    } finally {
      setClassBusy(false);
    }
  };

  const panel = (
    <section
      ref={panelRef}
      className={[styles.panel, adminOnly ? styles.adminOnlyPanel : "", className]
        .filter(Boolean)
        .join(" ")}
      aria-label={adminOnly ? "학급 관리" : "방문자 프로필과 학급 설정"}
      role={isBlocking ? "dialog" : undefined}
      aria-modal={isBlocking ? true : undefined}
    >
      {isBlocking ? blockingModalControl : null}
      {!profile && !adminOnly ? (
        <>
          <div className={styles.summary}>
            <span className={styles.profileIcon} aria-hidden="true">
              <School size={18} />
            </span>
            <div>
              <span>활성 프로필</span>
              <strong>
                {!profileReady ? "불러오는 중" : "프로필을 설정해 주세요"}
              </strong>
            </div>
            <button type="button" disabled={isBlocking}>
              {isBlocking ? "설정 필요" : "시작하기"}
            </button>
          </div>

          {editing ? (
            <>
              <form className={styles.profileForm} onSubmit={submitClassProfile}>
            <div className={styles.choiceHeading}>
              <strong>학급으로 참여하기</strong>
              <span>이름과 학급을 선택하면 작품과 갤러리를 이어서 사용할 수 있어요.</span>
            </div>
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
            <label>
              학급 선택
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
            {profileError ? <span className={styles.error} role="alert">{profileError}</span> : null}
            <button
              className={styles.primaryButton}
              type="submit"
              disabled={!classesReady || !selectedClass}
            >
              학급으로 시작하기
            </button>
              </form>

              <div className={styles.guestExperience}>
            <div>
              <strong>학급 없이 먼저 둘러볼까요?</strong>
              <p id="guest-experience-note" className={styles.guestNotice}>
              게스트는 트래킹과 다운로드를 체험할 수 있지만 갤러리·작품 클라우드
              저장은 사용할 수 없습니다.
              </p>
            </div>
            <button
              className={styles.guestButton}
              type="button"
              aria-describedby="guest-experience-note"
              onClick={() => saveProfile(true)}
            >
              게스트로 체험하기
            </button>
              </div>
            </>
          ) : null}
        </>
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
                <span className={styles.className}>{item.name}</span>
                <span className={styles.classActions}>
                  <button
                    className={styles.aiToggle}
                    type="button"
                    role="switch"
                    aria-checked={item.aiEnabled}
                    aria-label={`${item.name} AI 이미지 생성 ${item.aiEnabled ? "끄기" : "켜기"}`}
                    onClick={() => void toggleClassAi(item)}
                    disabled={classBusy}
                    data-enabled={item.aiEnabled}
                  >
                    <Sparkles size={14} aria-hidden="true" />
                    AI
                    <span>{item.aiEnabled ? "ON" : "OFF"}</span>
                  </button>
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
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {classesError ? <p className={styles.error} role="alert">{classesError}</p> : null}
      <p className={styles.status} role="status" aria-live="polite">{status}</p>
    </section>
  );

  if ((profile && !isAdmin) || (adminOnly && !isAdmin)) return null;

  return isBlocking ? (
    <div className={styles.blockingBackdrop}>{panel}</div>
  ) : (
    panel
  );
}

export default ClassOnboarding;
