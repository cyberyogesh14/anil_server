const ApiError = require('../services/ApiError');
const { MAX_IMAGES } = require('./bulkProduct');

const ALLOWED_MIME = /^image\/(jpeg|jpg|png|gif|webp)$/i;

async function uploadGroupImages(files = []) {
  if (files.length > MAX_IMAGES) {
    throw new ApiError(400, `A maximum of ${MAX_IMAGES} images is allowed`);
  }
  for (const file of files) {
    if (!ALLOWED_MIME.test(file.mimetype)) {
      throw new ApiError(400, 'Only JPG, PNG, GIF and WebP images are allowed');
    }
    if (file.size > 5 * 1024 * 1024) {
      throw new ApiError(400, 'Each image must be 5MB or smaller');
    }
  }
  if (!files.length) return [];

  const { cloudinary } = require('../config/cloudinary');
  const uploaded = await Promise.all(
    files.map(
      (file) =>
        new Promise((resolve, reject) => {
          const stream = cloudinary.uploader.upload_stream(
            {
              folder: 'anilkabadi/products',
              transformation: [{ width: 800, height: 800, crop: 'limit' }],
            },
            (error, result) => {
              if (error) return reject(error);
              resolve({ url: result.secure_url, publicId: result.public_id });
            }
          );
          stream.end(file.buffer);
        })
    )
  );
  return uploaded;
}

async function destroyGroupImages(images = []) {
  const publicIds = images.map((image) => image.publicId).filter(Boolean);
  if (!publicIds.length) return;
  try {
    const { cloudinary } = require('../config/cloudinary');
    await Promise.all(publicIds.map((id) => cloudinary.uploader.destroy(id).catch(() => null)));
  } catch {
    return;
  }
}

module.exports = { uploadGroupImages, destroyGroupImages };
