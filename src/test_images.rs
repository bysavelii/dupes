//! Картинки для тестов: рисуются кодом, чтобы в репозитории не лежали бинарные образцы.

#![allow(dead_code)] // Файл подключается и в модульные, и в интеграционные тесты; каждому нужна своя часть.

use image::{Rgb, RgbImage};

const BRIGHTEST: f32 = 255.0;
const NOISE_AMPLITUDE: u32 = 6;
const NOISE_MULTIPLIER_X: u32 = 73_856_093;
const NOISE_MULTIPLIER_Y: u32 = 19_349_663;
const MARK_BRIGHTNESS: f32 = 255.0;
const MARK_SIDE_SHARE: f32 = 0.18;
const MARK_CORNER_SHARE: f32 = 0.04;

/// Градиент, светлеющий слева направо.
pub fn brightening_gradient(width: u32, height: u32) -> RgbImage {
    horizontal_gradient(width, height, |progress| progress)
}

/// Градиент, темнеющий слева направо.
pub fn darkening_gradient(width: u32, height: u32) -> RgbImage {
    horizontal_gradient(width, height, |progress| 1.0 - progress)
}

/// `brightness_at` получает долю пути по ширине (от 0 до 1) и возвращает яркость от 0 до 1.
fn horizontal_gradient(width: u32, height: u32, brightness_at: fn(f32) -> f32) -> RgbImage {
    RgbImage::from_fn(width, height, |x, _| {
        let progress = x as f32 / (width - 1) as f32;
        gray(brightness_at(progress) * BRIGHTEST)
    })
}

/// Светлый круг и тёмный прямоугольник на фоне, светлеющем вправо.
pub fn scene_image(width: u32, height: u32) -> RgbImage {
    scene(width, height, &SCENE)
}

/// Та же сцена с белым квадратом-меткой в левом верхнем углу.
pub fn scene_with_mark_image(width: u32, height: u32) -> RgbImage {
    scene(width, height, &SCENE_WITH_MARK)
}

/// Небольшой шум делает PNG заметно больше JPEG, как у настоящих фотографий.
pub fn with_noise(image: &RgbImage) -> RgbImage {
    RgbImage::from_fn(image.width(), image.height(), |x, y| {
        let mixed = x.wrapping_mul(NOISE_MULTIPLIER_X) ^ y.wrapping_mul(NOISE_MULTIPLIER_Y);
        let noise = (mixed >> 7).wrapping_rem(NOISE_AMPLITUDE) as f32;
        gray(image.get_pixel(x, y)[0] as f32 + noise)
    })
}

/// Другой рисунок: фон темнеет вправо, фигуры стоят в других местах.
pub fn other_scene_image(width: u32, height: u32) -> RgbImage {
    scene(width, height, &OTHER_SCENE)
}

struct Scene {
    background_start: f32,
    background_end: f32,
    circle_center: (f32, f32),
    circle_radius: f32,
    rectangle: (f32, f32, f32, f32),
    has_mark: bool,
}

const SCENE: Scene = Scene {
    background_start: 60.0,
    background_end: 160.0,
    circle_center: (0.3, 0.5),
    circle_radius: 0.2,
    rectangle: (0.6, 0.2, 0.9, 0.8),
    has_mark: false,
};

const SCENE_WITH_MARK: Scene = Scene {
    has_mark: true,
    ..SCENE
};

const OTHER_SCENE: Scene = Scene {
    background_start: 200.0,
    background_end: 100.0,
    circle_center: (0.75, 0.3),
    circle_radius: 0.15,
    rectangle: (0.1, 0.55, 0.45, 0.9),
    has_mark: false,
};

const CIRCLE_BRIGHTNESS: f32 = 240.0;
const RECTANGLE_BRIGHTNESS: f32 = 10.0;

fn scene(width: u32, height: u32, scene: &Scene) -> RgbImage {
    RgbImage::from_fn(width, height, |x, y| {
        let column = (x as f32 + 0.5) / width as f32;
        let row = (y as f32 + 0.5) / height as f32;
        gray(scene_brightness(column, row, scene))
    })
}

fn scene_brightness(column: f32, row: f32, scene: &Scene) -> f32 {
    let (center_column, center_row) = scene.circle_center;
    let is_in_circle = (column - center_column).hypot(row - center_row) < scene.circle_radius;
    let (left, top, right, bottom) = scene.rectangle;
    let is_in_rectangle = (left..right).contains(&column) && (top..bottom).contains(&row);

    let mark_range = MARK_CORNER_SHARE..(MARK_CORNER_SHARE + MARK_SIDE_SHARE);
    let is_in_mark = scene.has_mark && mark_range.contains(&column) && mark_range.contains(&row);

    if is_in_mark {
        return MARK_BRIGHTNESS;
    }
    if is_in_circle {
        return CIRCLE_BRIGHTNESS;
    }
    if is_in_rectangle {
        return RECTANGLE_BRIGHTNESS;
    }
    scene.background_start + (scene.background_end - scene.background_start) * column
}

fn gray(brightness: f32) -> Rgb<u8> {
    let level = brightness.round().clamp(0.0, BRIGHTEST) as u8;
    Rgb([level, level, level])
}
