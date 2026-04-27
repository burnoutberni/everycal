import { useMemo, useState, type ChangeEvent } from "react";
import { useTranslation } from "react-i18next";
import { PASSWORD_MIN_LENGTH } from "@everycal/core";
import { evaluatePasswordStrength } from "../lib/passwordStrength";

type PasswordInputProps = {
  id: string;
  value: string;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  minLength?: number;
  autoComplete?: string;
  required?: boolean;
  autoFocus?: boolean;
  disabled?: boolean;
  showStrengthFeedback?: boolean;
};

export function PasswordInput({
  id,
  value,
  onChange,
  minLength,
  autoComplete,
  required,
  autoFocus,
  disabled,
  showStrengthFeedback = false,
}: PasswordInputProps) {
  const { t } = useTranslation("auth");
  const [isVisible, setIsVisible] = useState(false);
  const resolvedMinLength = minLength ?? PASSWORD_MIN_LENGTH;
  const getRequirementStateLabel = (rule: string, isMet: boolean) =>
    t("passwordRequirementStateLabel", {
      rule,
      status: t(isMet ? "passwordRequirementMet" : "passwordRequirementNotMet"),
    });
  const strength = useMemo(() => {
    if (!showStrengthFeedback) {
      return null;
    }

    return evaluatePasswordStrength(value, resolvedMinLength);
  }, [resolvedMinLength, showStrengthFeedback, value]);

  const strengthText = useMemo(() => {
    if (!showStrengthFeedback || strength === null) {
      return null;
    }

    return value.length === 0 ? t("passwordStrengthEnter") : t(`passwordStrength.${strength.level}`);
  }, [showStrengthFeedback, strength, t, value]);

  return (
    <>
      <div className="password-input-wrap">
        <input
          id={id}
          type={isVisible ? "text" : "password"}
          value={value}
          onChange={onChange}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          autoComplete={autoComplete}
          required={required}
          minLength={minLength}
          autoFocus={autoFocus}
          disabled={disabled}
          aria-describedby={showStrengthFeedback ? `${id}-strength ${id}-requirements` : undefined}
        />
        <button
          type="button"
          className="password-visibility-toggle"
          onClick={() => setIsVisible((visible) => !visible)}
          aria-label={isVisible ? t("hidePassword") : t("showPassword")}
          aria-pressed={isVisible}
        >
          {isVisible ? t("hide") : t("show")}
        </button>
      </div>

      {showStrengthFeedback && strength !== null && strengthText !== null && (
        <div className="password-strength-feedback">
          <p id={`${id}-strength`} className="text-sm text-dim mt-1" role="status" aria-live="polite" aria-atomic="true">
            {t("passwordStrengthLabel")}: <strong>{strengthText}</strong>
          </p>
          <div className="password-strength-meter" role="presentation" aria-hidden="true">
            {Array.from({ length: 4 }).map((_, index) => (
              <span
                key={index}
                className={`password-strength-meter-segment ${index < strength.score ? `is-${strength.level}` : "is-empty"}`}
              />
            ))}
          </div>
          <div id={`${id}-requirements`}>
            <p className="text-sm text-dim mt-1">{t("passwordRequiredLabel")}</p>
            <ul className="password-requirements-list text-sm text-dim" aria-label={t("passwordRequiredLabel")}>
              <li
                className={strength.checks.minLength ? "is-met" : ""}
                aria-label={getRequirementStateLabel(
                  t("passwordRuleMinLength", { min: resolvedMinLength }),
                  strength.checks.minLength
                )}
              >
                {t("passwordRuleMinLength", { min: resolvedMinLength })}
              </li>
            </ul>
            <p className="text-sm text-dim mt-1">{t("passwordTipsLabel")}</p>
            <ul className="password-requirements-list text-sm text-dim" aria-label={t("passwordTipsLabel")}>
              <li
                className={strength.checks.mixedCase ? "is-met" : ""}
                aria-label={getRequirementStateLabel(t("passwordRuleMixedCase"), strength.checks.mixedCase)}
              >
                {t("passwordRuleMixedCase")}
              </li>
              <li
                className={strength.checks.number ? "is-met" : ""}
                aria-label={getRequirementStateLabel(t("passwordRuleNumber"), strength.checks.number)}
              >
                {t("passwordRuleNumber")}
              </li>
              <li
                className={strength.checks.symbol ? "is-met" : ""}
                aria-label={getRequirementStateLabel(t("passwordRuleSymbol"), strength.checks.symbol)}
              >
                {t("passwordRuleSymbol")}
              </li>
            </ul>
          </div>
        </div>
      )}
    </>
  );
}
