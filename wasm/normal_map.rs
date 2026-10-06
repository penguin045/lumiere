#![no_std]

use core::panic::PanicInfo;

const MAX_PIXELS: usize = 512 * 512;
const BUFFER_BYTES: usize = MAX_PIXELS * 4;

static mut INPUT: [u8; BUFFER_BYTES] = [0; BUFFER_BYTES];
static mut OUTPUT: [u8; BUFFER_BYTES] = [0; BUFFER_BYTES];

#[panic_handler]
fn panic(_: &PanicInfo) -> ! {
    loop {}
}

#[unsafe(no_mangle)]
pub extern "C" fn input_ptr() -> u32 {
    core::ptr::addr_of_mut!(INPUT) as u32
}

#[unsafe(no_mangle)]
pub extern "C" fn output_ptr() -> u32 {
    core::ptr::addr_of_mut!(OUTPUT) as u32
}

#[inline]
fn depth_at(width: usize, height: usize, x: isize, y: isize) -> f32 {
    let px = x.clamp(0, width as isize - 1) as usize;
    let py = y.clamp(0, height as isize - 1) as usize;
    let offset = (py * width + px) * 4;
    unsafe { *core::ptr::addr_of!(INPUT).cast::<u8>().add(offset) as f32 / 255.0 }
}

#[inline]
fn square_root(value: f32) -> f32 {
    let mut estimate = 1.0 + value * 0.25;
    for _ in 0..6 {
        estimate = (estimate + value / estimate) * 0.5;
    }
    estimate
}

#[unsafe(no_mangle)]
pub extern "C" fn generate_normals(width: u32, height: u32) -> u32 {
    let width = width as usize;
    let height = height as usize;
    if width == 0 || height == 0 || width * height > MAX_PIXELS {
        return 0;
    }

    let output = core::ptr::addr_of_mut!(OUTPUT).cast::<u8>();
    for y in 0..height {
        for x in 0..width {
            let x = x as isize;
            let y = y as isize;
            let left = (depth_at(width, height, x - 4, y - 2)
                + depth_at(width, height, x - 4, y)
                + depth_at(width, height, x - 4, y + 2)) / 3.0;
            let right = (depth_at(width, height, x + 4, y - 2)
                + depth_at(width, height, x + 4, y)
                + depth_at(width, height, x + 4, y + 2)) / 3.0;
            let below = (depth_at(width, height, x - 2, y + 4)
                + depth_at(width, height, x, y + 4)
                + depth_at(width, height, x + 2, y + 4)) / 3.0;
            let above = (depth_at(width, height, x - 2, y - 4)
                + depth_at(width, height, x, y - 4)
                + depth_at(width, height, x + 2, y - 4)) / 3.0;
            let nx = (left - right) * 2.5;
            let ny = (below - above) * 2.5;
            let length = square_root(nx * nx + ny * ny + 1.0);
            let offset = (y as usize * width + x as usize) * 4;
            unsafe {
                *output.add(offset) = ((nx / length * 0.5 + 0.5) * 255.0 + 0.5) as u8;
                *output.add(offset + 1) = ((ny / length * 0.5 + 0.5) * 255.0 + 0.5) as u8;
                *output.add(offset + 2) = ((1.0 / length * 0.5 + 0.5) * 255.0 + 0.5) as u8;
                *output.add(offset + 3) = 255;
            }
        }
    }
    1
}
