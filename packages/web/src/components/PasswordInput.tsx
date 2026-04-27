import { useMemo, useState, type ChangeEvent } from "react";
import { useTranslation } from "react-i18next";
import { evaluatePasswordStrength } from "../lib/passwordStrength";

type PasswordInputProps = {
  id: string;
  value: string;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  autoComplete?: string;
  required?: boolean;
  minLength?: number;
  autoFocus?: boolean;
  disabled?: boolean;
  showStrengthFeedback?: boolean;
};

export function PasswordInput({
  id,
  value,
  onChange,
  autoComplete,
  required,
  minLength,
  autoFocus,
  disabled,
  showStrengthFeedback = false,
}: PasswordInputProps) {
  const { t } = useTranslation("auth");
  const [isVisible, setIsVisible] = useState(false);
  const strength = useMemo(() => evaluatePasswordStrength(value), [value]);
  const strengthText = value.length === 0 ? t("passwordStrengthEnter") : t(`passwordStrength.${strength.level}`);

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

      {showStrengthFeedback && (
        <div className="password-strength-feedback" aria-live="polite">
          <p id={`${id}-strength`} className="text-sm text-dim mt-1">
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
          <ul id={`${id}-requirements`} className="password-requirements-list text-sm text-dim" aria-label={t("passwordRequirements")}>
            <li className={strength.checks.minLength ? "is-met" : ""}>{t("passwordRuleMinLength")}</li>
            <li className={strength.checks.mixedCase ? "is-met" : ""}>{t("passwordRuleMixedCase")}</li>
            <li className={strength.checks.number ? "is-met" : ""}>{t("passwordRuleNumber")}</li>
            <li className={strength.checks.symbol ? "is-met" : ""}>{t("passwordRuleSymbol")}</li>
          </ul>
        </div>
      )}
    </>
  );
}
