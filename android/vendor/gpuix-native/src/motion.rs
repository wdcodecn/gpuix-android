//! Native motion tracks resolved during GPUI rendering, outside React.

use std::time::Duration;

use serde::Deserialize;
use web_time::Instant;

use crate::style::{DimensionValue, StyleDesc};

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MotionStyle {
    pub width: Option<f64>,
    pub height: Option<f64>,
    pub opacity: Option<f64>,
    pub top: Option<f64>,
    pub right: Option<f64>,
    pub bottom: Option<f64>,
    pub left: Option<f64>,
    pub border_radius: Option<f64>,
}

impl MotionStyle {
    fn with_fallback(self, fallback: Self) -> Self {
        Self {
            width: self.width.or(fallback.width),
            height: self.height.or(fallback.height),
            opacity: self.opacity.or(fallback.opacity),
            top: self.top.or(fallback.top),
            right: self.right.or(fallback.right),
            bottom: self.bottom.or(fallback.bottom),
            left: self.left.or(fallback.left),
            border_radius: self.border_radius.or(fallback.border_radius),
        }
    }

    fn interpolate(self, target: Self, progress: f64) -> Self {
        fn value(from: Option<f64>, to: Option<f64>, progress: f64) -> Option<f64> {
            to.map(|to| from.unwrap_or(to) + (to - from.unwrap_or(to)) * progress)
        }

        Self {
            width: value(self.width, target.width, progress),
            height: value(self.height, target.height, progress),
            opacity: value(self.opacity, target.opacity, progress),
            top: value(self.top, target.top, progress),
            right: value(self.right, target.right, progress),
            bottom: value(self.bottom, target.bottom, progress),
            left: value(self.left, target.left, progress),
            border_radius: value(self.border_radius, target.border_radius, progress),
        }
    }

    pub(crate) fn apply_to(self, style: &mut StyleDesc) {
        if let Some(value) = self.width {
            style.width = Some(DimensionValue::Pixels(value));
        }
        if let Some(value) = self.height {
            style.height = Some(DimensionValue::Pixels(value));
        }
        if let Some(value) = self.opacity {
            style.opacity = Some(value);
        }
        if let Some(value) = self.top {
            style.top = Some(value);
        }
        if let Some(value) = self.right {
            style.right = Some(value);
        }
        if let Some(value) = self.bottom {
            style.bottom = Some(value);
        }
        if let Some(value) = self.left {
            style.left = Some(value);
        }
        if let Some(value) = self.border_radius {
            style.border_radius = Some(value);
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(untagged)]
enum MotionInitial {
    Disabled(bool),
    Style(MotionStyle),
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(untagged)]
enum MotionEase {
    Name(String),
    CubicBezier([f64; 4]),
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct MotionTransition {
    #[serde(rename = "type", default)]
    transition_type: Option<String>,
    #[serde(default = "default_duration")]
    duration: f64,
    #[serde(default)]
    delay: f64,
    #[serde(default = "default_ease")]
    ease: MotionEase,
    #[serde(default)]
    stiffness: Option<f64>,
    #[serde(default)]
    damping: Option<f64>,
    #[serde(default)]
    mass: Option<f64>,
    #[serde(default)]
    velocity: Option<f64>,
    #[serde(default)]
    rest_delta: Option<f64>,
    #[serde(default)]
    rest_speed: Option<f64>,
}

impl Default for MotionTransition {
    fn default() -> Self {
        Self {
            transition_type: None,
            duration: default_duration(),
            delay: 0.0,
            ease: default_ease(),
            stiffness: None,
            damping: None,
            mass: None,
            velocity: None,
            rest_delta: None,
            rest_speed: None,
        }
    }
}

impl MotionTransition {
    fn is_spring(&self) -> bool {
        matches!(self.transition_type.as_deref(), Some("spring"))
    }
}

fn default_duration() -> f64 {
    0.3
}

fn default_ease() -> MotionEase {
    MotionEase::Name("easeOut".to_string())
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct MotionDescription {
    #[serde(default)]
    generation: u64,
    #[serde(default)]
    is_exit: bool,
    #[serde(default)]
    initial: Option<MotionInitial>,
    animate: MotionStyle,
    #[serde(default)]
    transition: MotionTransition,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct MotionFrame {
    pub active: bool,
    pub just_settled: bool,
    pub generation: u64,
}

pub(crate) struct MotionState {
    source: serde_json::Value,
    from: MotionStyle,
    target: MotionStyle,
    velocities: MotionStyle,
    transition: MotionTransition,
    started: Instant,
    valid: bool,
    needs_settle: bool,
    generation: u64,
}

impl MotionState {
    pub(crate) fn new(source: &serde_json::Value, now: Instant) -> Result<Self, String> {
        let description = parse_description(source)?;
        let from = match description.initial {
            Some(MotionInitial::Style(style)) => style,
            Some(MotionInitial::Disabled(false)) | None => description.animate,
            Some(MotionInitial::Disabled(true)) => unreachable!("validated above"),
        };

        let target = description.animate.with_fallback(from);
        let initial_v = description.transition.velocity.unwrap_or(0.0);
        let velocities = initial_velocities(from, target, initial_v);
        Ok(Self {
            source: source.clone(),
            from,
            target,
            velocities,
            transition: description.transition,
            started: now,
            valid: true,
            needs_settle: description.is_exit || from != target,
            generation: description.generation,
        })
    }

    pub(crate) fn invalid(source: &serde_json::Value, now: Instant) -> Self {
        Self {
            source: source.clone(),
            from: MotionStyle::default(),
            target: MotionStyle::default(),
            velocities: MotionStyle::default(),
            transition: MotionTransition::default(),
            started: now,
            valid: false,
            needs_settle: source_is_exit(source),
            generation: source_generation(source),
        }
    }

    pub(crate) fn sync(&mut self, source: &serde_json::Value, now: Instant) -> Result<(), String> {
        if self.source == *source {
            return Ok(());
        }

        let previous_generation = self.generation;
        let description = match parse_description(source) {
            Ok(description) => description,
            Err(error) => {
                self.source = source.clone();
                self.valid = false;
                self.generation = source_generation(source);
                self.needs_settle =
                    source_is_exit(source) || self.generation != previous_generation;
                return Err(error);
            }
        };
        let prev_sample = if self.valid {
            Some(self.sample_with_velocities(now))
        } else {
            None
        };
        self.from = if let Some((style, _, _)) = prev_sample {
            style
        } else {
            match description.initial {
                Some(MotionInitial::Style(style)) => style,
                Some(MotionInitial::Disabled(false)) | None => description.animate,
                Some(MotionInitial::Disabled(true)) => unreachable!("validated above"),
            }
        };
        self.target = description.animate.with_fallback(self.from);
        self.velocities = if let Some(explicit_v) = description.transition.velocity {
            initial_velocities(self.from, self.target, explicit_v)
        } else if let Some((_, vel, _)) = prev_sample {
            vel
        } else {
            MotionStyle::default()
        };
        self.transition = description.transition;
        self.started = now;
        self.source = source.clone();
        self.valid = true;
        self.generation = description.generation;
        self.needs_settle = description.is_exit
            || self.generation != previous_generation
            || self.from != self.target
            || has_nonzero_velocity(self.velocities);
        Ok(())
    }

    pub(crate) fn visible_style(&self, now: Instant) -> Option<MotionStyle> {
        self.valid.then(|| self.sample(now).0)
    }

    fn sample(&self, now: Instant) -> (MotionStyle, bool) {
        let (style, _, active) = self.sample_with_velocities(now);
        (style, active)
    }

    fn sample_with_velocities(&self, now: Instant) -> (MotionStyle, MotionStyle, bool) {
        if self.transition.is_spring() {
            return self.sample_spring(now);
        }
        let delay = seconds(self.transition.delay);
        let duration = seconds(self.transition.duration);
        let elapsed = now.saturating_duration_since(self.started);
        let raw = if duration.is_zero() {
            if elapsed < delay {
                0.0
            } else {
                1.0
            }
        } else if elapsed <= delay {
            0.0
        } else {
            elapsed.saturating_sub(delay).as_secs_f64() / duration.as_secs_f64()
        };
        let active = self.from != self.target && raw < 1.0;
        let clamped = raw.clamp(0.0, 1.0);
        let progress = ease(clamped, &self.transition.ease);
        let style = self.from.interpolate(self.target, progress);
        let velocities = if active && !duration.is_zero() {
            let dur_s = duration.as_secs_f64();
            let dt_raw = 0.001 / dur_s;
            let p_lo = ease((clamped - dt_raw).clamp(0.0, 1.0), &self.transition.ease);
            let p_hi = ease((clamped + dt_raw).clamp(0.0, 1.0), &self.transition.ease);
            let dprogress_dt = (p_hi - p_lo) / ((clamped + dt_raw).min(1.0) - (clamped - dt_raw).max(0.0)).max(1e-9) / dur_s;
            derive_tween_velocities(self.from, self.target, dprogress_dt)
        } else {
            MotionStyle::default()
        };
        (style, velocities, active)
    }

    fn sample_spring(&self, now: Instant) -> (MotionStyle, MotionStyle, bool) {
        let delay = seconds(self.transition.delay);
        let elapsed = now.saturating_duration_since(self.started);
        if elapsed <= delay {
            let active = self.from != self.target || has_nonzero_velocity(self.velocities);
            return (self.from, self.velocities, active);
        }
        let t = elapsed.saturating_sub(delay).as_secs_f64();
        let stiffness = self.transition.stiffness.unwrap_or(300.0);
        let damping = self.transition.damping.unwrap_or(24.0);
        let mass = self.transition.mass.unwrap_or(1.0);
        let rest_delta = self.transition.rest_delta.unwrap_or(0.05);
        let rest_speed = self.transition.rest_speed.unwrap_or(0.5);

        let mut any_active = false;

        let mut step_prop = |from: Option<f64>,
                             to: Option<f64>,
                             vel: Option<f64>,
                             unit_scale: f64,
                             min_clamp: Option<f64>,
                             max_clamp: Option<f64>|
         -> (Option<f64>, Option<f64>) {
            let Some(target) = to else {
                return (None, None);
            };
            let x0 = from.unwrap_or(target);
            let v0 = vel.unwrap_or(0.0);
            let (mut pos, v, active) = solve_spring_prop(
                x0,
                v0,
                target,
                t,
                stiffness,
                damping,
                mass,
                rest_delta * unit_scale,
                rest_speed * unit_scale,
            );
            if let Some(lo) = min_clamp {
                pos = pos.max(lo);
            }
            if let Some(hi) = max_clamp {
                pos = pos.min(hi);
            }
            if active {
                any_active = true;
            }
            (Some(pos), Some(v))
        };

        let (width, v_width) =
            step_prop(self.from.width, self.target.width, self.velocities.width, 1.0, Some(0.0), None);
        let (height, v_height) =
            step_prop(self.from.height, self.target.height, self.velocities.height, 1.0, Some(0.0), None);
        let (opacity, v_opacity) = step_prop(
            self.from.opacity,
            self.target.opacity,
            self.velocities.opacity,
            0.02,
            Some(0.0),
            Some(1.0),
        );
        let (top, v_top) =
            step_prop(self.from.top, self.target.top, self.velocities.top, 1.0, None, None);
        let (right, v_right) =
            step_prop(self.from.right, self.target.right, self.velocities.right, 1.0, None, None);
        let (bottom, v_bottom) =
            step_prop(self.from.bottom, self.target.bottom, self.velocities.bottom, 1.0, None, None);
        let (left, v_left) =
            step_prop(self.from.left, self.target.left, self.velocities.left, 1.0, None, None);
        let (border_radius, v_border_radius) = step_prop(
            self.from.border_radius,
            self.target.border_radius,
            self.velocities.border_radius,
            1.0,
            Some(0.0),
            None,
        );

        let style = MotionStyle {
            width,
            height,
            opacity,
            top,
            right,
            bottom,
            left,
            border_radius,
        };
        let velocities = MotionStyle {
            width: v_width,
            height: v_height,
            opacity: v_opacity,
            top: v_top,
            right: v_right,
            bottom: v_bottom,
            left: v_left,
            border_radius: v_border_radius,
        };
        (style, velocities, any_active)
    }

    pub(crate) fn frame(&mut self, now: Instant) -> MotionFrame {
        let (_, active) = if self.valid {
            self.sample(now)
        } else {
            (MotionStyle::default(), false)
        };
        if active {
            self.needs_settle = true;
        }
        let just_settled = self.needs_settle && !active;
        if just_settled {
            self.needs_settle = false;
        }
        MotionFrame {
            active,
            just_settled,
            generation: self.generation,
        }
    }
}

fn source_generation(source: &serde_json::Value) -> u64 {
    source
        .get("generation")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or_default()
}

fn source_is_exit(source: &serde_json::Value) -> bool {
    source
        .get("isExit")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or_default()
}

fn parse_description(source: &serde_json::Value) -> Result<MotionDescription, String> {
    let description: MotionDescription =
        serde_json::from_value(source.clone()).map_err(|error| error.to_string())?;

    if matches!(description.initial, Some(MotionInitial::Disabled(true))) {
        return Err("motion initial only accepts false or a style object".to_string());
    }
    validate_style(&description.animate)?;
    if let Some(MotionInitial::Style(initial)) = &description.initial {
        validate_style(initial)?;
    }
    validate_seconds(description.transition.duration, "duration")?;
    validate_seconds(description.transition.delay, "delay")?;
    validate_ease(&description.transition.ease)?;
    validate_transition(&description.transition)?;
    Ok(description)
}

fn validate_transition(transition: &MotionTransition) -> Result<(), String> {
    if let Some(kind) = transition.transition_type.as_deref() {
        if !matches!(kind, "tween" | "spring") {
            return Err(format!("unknown motion transition type: {kind}"));
        }
    }
    if let Some(stiffness) = transition.stiffness {
        if !stiffness.is_finite() || stiffness <= 0.0 {
            return Err("motion spring stiffness must be > 0".to_string());
        }
    }
    if let Some(damping) = transition.damping {
        if !damping.is_finite() || damping < 0.0 {
            return Err("motion spring damping must be >= 0".to_string());
        }
    }
    if let Some(mass) = transition.mass {
        if !mass.is_finite() || mass <= 0.0 {
            return Err("motion spring mass must be > 0".to_string());
        }
    }
    if let Some(velocity) = transition.velocity {
        if !velocity.is_finite() {
            return Err("motion spring velocity must be finite".to_string());
        }
    }
    if let Some(rest_delta) = transition.rest_delta {
        if !rest_delta.is_finite() || rest_delta <= 0.0 {
            return Err("motion spring restDelta must be > 0".to_string());
        }
    }
    if let Some(rest_speed) = transition.rest_speed {
        if !rest_speed.is_finite() || rest_speed <= 0.0 {
            return Err("motion spring restSpeed must be > 0".to_string());
        }
    }
    Ok(())
}

fn initial_velocities(from: MotionStyle, target: MotionStyle, velocity: f64) -> MotionStyle {
    if velocity == 0.0 {
        return MotionStyle::default();
    }
    let v = |f: Option<f64>, t: Option<f64>| match (f, t) {
        (Some(f), Some(t)) if (t - f).abs() > f64::EPSILON => Some(velocity),
        _ => None,
    };
    MotionStyle {
        width: v(from.width, target.width),
        height: v(from.height, target.height),
        opacity: v(from.opacity, target.opacity),
        top: v(from.top, target.top),
        right: v(from.right, target.right),
        bottom: v(from.bottom, target.bottom),
        left: v(from.left, target.left),
        border_radius: v(from.border_radius, target.border_radius),
    }
}

fn has_nonzero_velocity(vel: MotionStyle) -> bool {
    [
        vel.width,
        vel.height,
        vel.opacity,
        vel.top,
        vel.right,
        vel.bottom,
        vel.left,
        vel.border_radius,
    ]
    .into_iter()
    .flatten()
    .any(|v| v.abs() > f64::EPSILON)
}

fn derive_tween_velocities(from: MotionStyle, target: MotionStyle, dprogress_dt: f64) -> MotionStyle {
    let d = |f: Option<f64>, t: Option<f64>| t.map(|t| (t - f.unwrap_or(t)) * dprogress_dt);
    MotionStyle {
        width: d(from.width, target.width),
        height: d(from.height, target.height),
        opacity: d(from.opacity, target.opacity),
        top: d(from.top, target.top),
        right: d(from.right, target.right),
        bottom: d(from.bottom, target.bottom),
        left: d(from.left, target.left),
        border_radius: d(from.border_radius, target.border_radius),
    }
}

#[allow(clippy::too_many_arguments)]
fn solve_spring_prop(
    x0: f64,
    v0: f64,
    target: f64,
    t: f64,
    stiffness: f64,
    damping: f64,
    mass: f64,
    rest_delta: f64,
    rest_speed: f64,
) -> (f64, f64, bool) {
    let y0 = x0 - target;
    if (y0.abs() <= rest_delta && v0.abs() <= rest_speed) || t >= 10.0 {
        return (target, 0.0, false);
    }

    let omega0 = (stiffness / mass).sqrt();
    let zeta = damping / (2.0 * (stiffness * mass).sqrt());

    let (y, v) = if zeta < 1.0 - 1e-6 {
        // Underdamped harmonic oscillator
        let omega_d = omega0 * (1.0 - zeta * zeta).sqrt();
        let a = y0;
        let b = (zeta * omega0 * y0 + v0) / omega_d;
        let envelope = (-zeta * omega0 * t).exp();
        let (sin_wt, cos_wt) = (omega_d * t).sin_cos();
        let pos = envelope * (a * cos_wt + b * sin_wt);
        let vel = envelope
            * ((b * omega_d - zeta * omega0 * a) * cos_wt
                - (a * omega_d + zeta * omega0 * b) * sin_wt);
        (pos, vel)
    } else if zeta <= 1.0 + 1e-6 {
        // Critically damped
        let a = y0;
        let b = v0 + omega0 * y0;
        let envelope = (-omega0 * t).exp();
        let pos = envelope * (a + b * t);
        let vel = envelope * (b - omega0 * (a + b * t));
        (pos, vel)
    } else {
        // Overdamped
        let gamma = omega0 * (zeta * zeta - 1.0).sqrt();
        let r1 = -omega0 * zeta + gamma;
        let r2 = -omega0 * zeta - gamma;
        let c1 = (v0 - r2 * y0) / (2.0 * gamma);
        let c2 = y0 - c1;
        let e1 = (r1 * t).exp();
        let e2 = (r2 * t).exp();
        let pos = c1 * e1 + c2 * e2;
        let vel = c1 * r1 * e1 + c2 * r2 * e2;
        (pos, vel)
    };

    if t > 0.0 && y.abs() <= rest_delta && v.abs() <= rest_speed {
        (target, 0.0, false)
    } else {
        (target + y, v, true)
    }
}

fn validate_style(style: &MotionStyle) -> Result<(), String> {
    for (name, value) in [
        ("width", style.width),
        ("height", style.height),
        ("opacity", style.opacity),
        ("top", style.top),
        ("right", style.right),
        ("bottom", style.bottom),
        ("left", style.left),
        ("borderRadius", style.border_radius),
    ] {
        if value.is_some_and(|value| !value.is_finite() || value.abs() > f32::MAX as f64) {
            return Err(format!("motion {name} must fit a finite 32-bit float"));
        }
    }
    if style.width.is_some_and(|value| value < 0.0)
        || style.height.is_some_and(|value| value < 0.0)
        || style.border_radius.is_some_and(|value| value < 0.0)
    {
        return Err("motion sizes and borderRadius must be non-negative".to_string());
    }
    if style
        .opacity
        .is_some_and(|value| !(0.0..=1.0).contains(&value))
    {
        return Err("motion opacity must be between 0 and 1".to_string());
    }
    Ok(())
}

fn validate_seconds(value: f64, name: &str) -> Result<(), String> {
    if !value.is_finite() || value < 0.0 || Duration::try_from_secs_f64(value).is_err() {
        return Err(format!(
            "motion {name} must be a supported finite non-negative number"
        ));
    }
    Ok(())
}

fn validate_ease(ease: &MotionEase) -> Result<(), String> {
    match ease {
        MotionEase::Name(name)
            if matches!(
                name.as_str(),
                "linear" | "ease" | "easeIn" | "easeOut" | "easeInOut"
            ) => {}
        MotionEase::Name(name) => return Err(format!("unknown motion easing: {name}")),
        MotionEase::CubicBezier([x1, y1, x2, y2]) => {
            if ![x1, y1, x2, y2].iter().all(|value| value.is_finite())
                || !(0.0..=1.0).contains(x1)
                || !(0.0..=1.0).contains(x2)
            {
                return Err(
                    "motion cubic bezier values must be finite and x values must be 0..1"
                        .to_string(),
                );
            }
        }
    }
    Ok(())
}

fn seconds(value: f64) -> Duration {
    Duration::try_from_secs_f64(value).expect("motion durations are validated when parsed")
}

fn ease(progress: f64, ease: &MotionEase) -> f64 {
    let curve = match ease {
        MotionEase::CubicBezier(curve) => *curve,
        MotionEase::Name(name) => match name.as_str() {
            "linear" => return progress,
            "easeIn" => [0.42, 0.0, 1.0, 1.0],
            "easeInOut" => [0.42, 0.0, 0.58, 1.0],
            "ease" => [0.25, 0.1, 0.25, 1.0],
            _ => [0.0, 0.0, 0.58, 1.0],
        },
    };
    cubic_bezier(progress, curve)
}

fn cubic_bezier(x: f64, [x1, y1, x2, y2]: [f64; 4]) -> f64 {
    fn sample(t: f64, a: f64, b: f64) -> f64 {
        let c = 3.0 * a;
        let b = 3.0 * (b - a) - c;
        let a = 1.0 - c - b;
        ((a * t + b) * t + c) * t
    }

    let mut low = 0.0;
    let mut high = 1.0;
    for _ in 0..20 {
        let middle = (low + high) / 2.0;
        if sample(middle, x1, x2) < x {
            low = middle;
        } else {
            high = middle;
        }
    }
    sample((low + high) / 2.0, y1, y2).clamp(0.0, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interpolates_and_retargets_from_the_visible_value() {
        let started = Instant::now();
        let initial = serde_json::json!({
            "initial": { "width": 0.0 },
            "animate": { "width": 100.0 },
            "transition": { "duration": 1.0, "ease": "linear" }
        });
        let mut state = MotionState::new(&initial, started).unwrap();

        let middle = state.frame(started + Duration::from_millis(500));
        assert_eq!(
            state
                .visible_style(started + Duration::from_millis(500))
                .unwrap()
                .width,
            Some(50.0)
        );
        assert!(middle.active);
        assert!(!middle.just_settled);

        let reversed = serde_json::json!({
            "initial": false,
            "animate": { "width": 0.0 },
            "transition": { "duration": 1.0, "ease": "linear" }
        });
        let reversed_at = started + Duration::from_millis(500);
        state.sync(&reversed, reversed_at).unwrap();
        assert_eq!(state.visible_style(reversed_at).unwrap().width, Some(50.0));
        assert_eq!(
            state
                .visible_style(reversed_at + Duration::from_millis(500))
                .unwrap()
                .width,
            Some(25.0)
        );
    }

    #[test]
    fn disabled_initial_state_starts_at_the_target() {
        let now = Instant::now();
        let description = serde_json::json!({
            "initial": false,
            "animate": { "width": 260.0 },
            "transition": { "duration": 0.2 }
        });
        let mut state = MotionState::new(&description, now).unwrap();
        let frame = state.frame(now);

        assert_eq!(state.visible_style(now).unwrap().width, Some(260.0));
        assert!(!frame.active);
        assert!(!frame.just_settled);
    }

    #[test]
    fn rejects_unsafe_numbers_and_invalid_initial_booleans() {
        let now = Instant::now();
        for description in [
            serde_json::json!({ "animate": { "width": 1e300 }, "transition": {} }),
            serde_json::json!({ "animate": { "opacity": 2.0 }, "transition": {} }),
            serde_json::json!({ "animate": {}, "transition": { "duration": 1e300 } }),
            serde_json::json!({ "initial": true, "animate": {}, "transition": {} }),
        ] {
            assert!(MotionState::new(&description, now).is_err());
        }
    }

    #[test]
    fn finishes_at_the_exact_target() {
        let started = Instant::now();
        let description = serde_json::json!({
            "initial": { "width": 0.0 },
            "animate": { "width": 100.0 },
            "transition": { "duration": 0.2, "ease": "linear" }
        });
        let mut state = MotionState::new(&description, started).unwrap();
        let frame = state.frame(started + Duration::from_millis(200));

        assert_eq!(
            state
                .visible_style(started + Duration::from_millis(200))
                .unwrap()
                .width,
            Some(100.0)
        );
        assert!(!frame.active);
        assert!(frame.just_settled);
        assert!(
            !state
                .frame(started + Duration::from_millis(201))
                .just_settled
        );
    }

    #[test]
    fn retarget_with_zero_duration_settles_on_the_next_frame() {
        let started = Instant::now();
        let initial = serde_json::json!({
            "initial": false,
            "animate": { "opacity": 1.0 },
            "transition": { "duration": 0.2, "ease": "linear" }
        });
        let mut state = MotionState::new(&initial, started).unwrap();
        assert!(!state.frame(started).just_settled);

        let exit = serde_json::json!({
            "initial": false,
            "animate": { "opacity": 0.0 },
            "transition": { "duration": 0.0, "ease": "linear" }
        });
        state.sync(&exit, started).unwrap();
        let frame = state.frame(started);
        assert_eq!(state.visible_style(started).unwrap().opacity, Some(0.0));
        assert!(!frame.active);
        assert!(frame.just_settled);
    }

    #[test]
    fn a_new_generation_settles_when_the_target_already_matches() {
        let started = Instant::now();
        let initial = serde_json::json!({
            "generation": 1,
            "initial": false,
            "animate": { "opacity": 1.0 }
        });
        let mut state = MotionState::new(&initial, started).unwrap();

        let exit = serde_json::json!({
            "generation": 2,
            "initial": false,
            "animate": { "opacity": 1.0 }
        });
        state.sync(&exit, started).unwrap();

        assert!(state.frame(started).just_settled);
        assert!(!state.frame(started).just_settled);
    }

    #[test]
    fn retarget_keeps_values_omitted_from_the_new_target() {
        let started = Instant::now();
        let initial = serde_json::json!({
            "generation": 1,
            "initial": false,
            "animate": { "width": 100.0, "opacity": 1.0 },
            "transition": { "duration": 1.0, "ease": "linear" }
        });
        let mut state = MotionState::new(&initial, started).unwrap();

        let exit = serde_json::json!({
            "generation": 2,
            "initial": false,
            "animate": { "opacity": 0.0 },
            "transition": { "duration": 1.0, "ease": "linear" }
        });
        state.sync(&exit, started).unwrap();

        state.frame(started + Duration::from_millis(500));
        let style = state
            .visible_style(started + Duration::from_millis(500))
            .unwrap();
        assert_eq!(style.width, Some(100.0));
        assert_eq!(style.opacity, Some(0.5));
    }

    #[test]
    fn spring_underdamped_overshoots_and_settles() {
        let started = Instant::now();
        let desc = serde_json::json!({
            "initial": { "top": 0.0 },
            "animate": { "top": 100.0 },
            "transition": { "type": "spring", "stiffness": 300.0, "damping": 12.0, "mass": 1.0 }
        });
        let mut state = MotionState::new(&desc, started).unwrap();
        let mut max_top = 0.0_f64;
        for step_ms in (16..=600).step_by(16) {
            let v = state
                .visible_style(started + Duration::from_millis(step_ms))
                .unwrap()
                .top
                .unwrap();
            max_top = max_top.max(v);
        }
        assert!(max_top > 100.0, "expected underdamped overshoot, got max_top={max_top}");
        let end_frame = state.frame(started + Duration::from_millis(2500));
        assert!(!end_frame.active);
        assert_eq!(
            state
                .visible_style(started + Duration::from_millis(2500))
                .unwrap()
                .top,
            Some(100.0)
        );
    }

    #[test]
    fn spring_critical_and_overdamped_converge_monotonically() {
        let started = Instant::now();
        let critical = serde_json::json!({
            "initial": { "left": 0.0 },
            "animate": { "left": 100.0 },
            "transition": { "type": "spring", "stiffness": 256.0, "damping": 32.0, "mass": 1.0 }
        });
        let mut c_state = MotionState::new(&critical, started).unwrap();
        let mut prev = 0.0;
        for step_ms in (16..=1000).step_by(16) {
            let v = c_state
                .visible_style(started + Duration::from_millis(step_ms))
                .unwrap()
                .left
                .unwrap();
            assert!(v >= prev - 1e-6 && v <= 100.001, "critical overshoot {v} from {prev}");
            prev = v;
        }
        assert!(!c_state.frame(started + Duration::from_millis(2000)).active);

        let overdamped = serde_json::json!({
            "initial": { "left": 0.0 },
            "animate": { "left": 100.0 },
            "transition": { "type": "spring", "stiffness": 100.0, "damping": 40.0, "mass": 1.0 }
        });
        let mut o_state = MotionState::new(&overdamped, started).unwrap();
        assert!(!o_state.frame(started + Duration::from_millis(4000)).active);
        assert_eq!(
            o_state
                .visible_style(started + Duration::from_millis(4000))
                .unwrap()
                .left,
            Some(100.0)
        );
    }

    #[test]
    fn spring_retarget_preserves_position_and_momentum() {
        let started = Instant::now();
        let initial = serde_json::json!({
            "generation": 1,
            "initial": { "left": 0.0 },
            "animate": { "left": 200.0 },
            "transition": { "type": "spring", "stiffness": 300.0, "damping": 20.0, "mass": 1.0 }
        });
        let mut state = MotionState::new(&initial, started).unwrap();
        let interrupt_at = started + Duration::from_millis(80);
        let pos_at_interrupt = state.visible_style(interrupt_at).unwrap().left.unwrap();
        assert!(pos_at_interrupt > 10.0 && pos_at_interrupt < 180.0);

        let retarget = serde_json::json!({
            "generation": 2,
            "initial": false,
            "animate": { "left": 0.0 },
            "transition": { "type": "spring", "stiffness": 300.0, "damping": 20.0, "mass": 1.0 }
        });
        state.sync(&retarget, interrupt_at).unwrap();
        assert!((state.visible_style(interrupt_at).unwrap().left.unwrap() - pos_at_interrupt).abs() < 1e-6);
        // Because velocity was positive (~moving right) toward 200, immediately after retargeting
        // back to 0 the element keeps carrying positive momentum briefly before turning around!
        let pos_just_after = state
            .visible_style(interrupt_at + Duration::from_millis(10))
            .unwrap()
            .left
            .unwrap();
        assert!(
            pos_just_after > pos_at_interrupt,
            "expected inherited positive velocity carry-over: {pos_just_after} vs {pos_at_interrupt}"
        );
        assert!(!state.frame(interrupt_at + Duration::from_millis(3000)).active);
    }
}
