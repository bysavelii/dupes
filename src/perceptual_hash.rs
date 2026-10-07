use image::imageops::{self, FilterType};
use image::{DynamicImage, GrayImage};

const HASH_ROWS: u32 = 8;
const COMPARISONS_PER_ROW: u32 = 8;
// На одно сравнение больше, чем бит в строке: у крайнего пикселя справа нет соседа.
const RESIZED_WIDTH: u32 = COMPARISONS_PER_ROW + 1;
pub const HASH_BITS: u32 = HASH_ROWS * COMPARISONS_PER_ROW;

/// Отпечаток внешнего вида картинки (dHash): у одного и того же изображения в другом размере
/// или качестве он почти не меняется.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PerceptualHash(u64);

impl PerceptualHash {
    pub fn of_image(image: &DynamicImage) -> Self {
        let grayscale = image.to_luma8();
        let resized = imageops::resize(&grayscale, RESIZED_WIDTH, HASH_ROWS, FilterType::Triangle);

        Self(brightness_steps(&resized))
    }

    #[cfg(test)]
    pub fn from_bits(bits: u64) -> Self {
        Self(bits)
    }

    #[cfg(test)]
    pub fn bits(self) -> u64 {
        self.0
    }

    /// Сколько битов отличают отпечатки: чем меньше, тем больше картинки похожи.
    pub fn distance(self, other: Self) -> u32 {
        (self.0 ^ other.0).count_ones()
    }
}

/// Бит равен 1, если пиксель темнее соседа справа; биты идут строка за строкой.
fn brightness_steps(resized: &GrayImage) -> u64 {
    let mut bits = 0;
    for row in 0..HASH_ROWS {
        for column in 0..COMPARISONS_PER_ROW {
            let pixel = resized.get_pixel(column, row).0[0];
            let right_neighbour = resized.get_pixel(column + 1, row).0[0];
            let is_darker_than_neighbour = pixel < right_neighbour;
            bits = (bits << 1) | u64::from(is_darker_than_neighbour);
        }
    }
    bits
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_images::{
        brightening_gradient, darkening_gradient, other_scene_image, scene_image,
    };

    const FULL_SIZE: (u32, u32) = (640, 480);
    const SMALL_SIZE: (u32, u32) = (160, 120);
    const MAX_DISTANCE_AFTER_RESIZE: u32 = 1;
    const MIN_DISTANCE_OF_DIFFERENT_PICTURES: u32 = HASH_BITS / 2;

    fn hash_of(image: image::RgbImage) -> PerceptualHash {
        PerceptualHash::of_image(&DynamicImage::ImageRgb8(image))
    }

    #[test]
    fn gradient_brightening_to_the_right_sets_every_bit() {
        let hash = hash_of(brightening_gradient(FULL_SIZE.0, FULL_SIZE.1));

        assert_eq!(hash, PerceptualHash(u64::MAX));
    }

    #[test]
    fn gradient_darkening_to_the_right_sets_no_bits() {
        let hash = hash_of(darkening_gradient(FULL_SIZE.0, FULL_SIZE.1));

        assert_eq!(hash, PerceptualHash(0));
    }

    #[test]
    fn opposite_gradients_differ_in_every_bit() {
        let brightening = hash_of(brightening_gradient(FULL_SIZE.0, FULL_SIZE.1));
        let darkening = hash_of(darkening_gradient(FULL_SIZE.0, FULL_SIZE.1));

        assert_eq!(brightening.distance(darkening), HASH_BITS);
        assert_eq!(brightening.distance(brightening), 0);
    }

    #[test]
    fn shrunk_copy_has_almost_the_same_hash() {
        let original = hash_of(scene_image(FULL_SIZE.0, FULL_SIZE.1));
        let shrunk = hash_of(scene_image(SMALL_SIZE.0, SMALL_SIZE.1));

        assert!(original.distance(shrunk) <= MAX_DISTANCE_AFTER_RESIZE);
    }

    #[test]
    fn different_picture_has_a_distant_hash() {
        let scene = hash_of(scene_image(FULL_SIZE.0, FULL_SIZE.1));
        let other = hash_of(other_scene_image(FULL_SIZE.0, FULL_SIZE.1));

        assert!(scene.distance(other) > MIN_DISTANCE_OF_DIFFERENT_PICTURES);
    }

    #[test]
    fn repeated_computation_gives_the_same_hash() {
        let image = scene_image(FULL_SIZE.0, FULL_SIZE.1);

        assert_eq!(hash_of(image.clone()), hash_of(image));
    }
}
