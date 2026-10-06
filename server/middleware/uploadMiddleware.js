const multer = require('multer');
const path = require('path');

/**
 * Uploads are held in memory, not written to disk.
 *
 * Every uploaded file is immediately streamed to Cloudinary and then deleted
 * again (`fs.unlink` in the product and category controllers), so the disk write
 * served no purpose: it was one full write plus one unlink syscall per image on
 * a single filesystem, which on a container with a small writable layer or a
 * networked volume is both slow and a capacity risk under concurrent uploads.
 *
 * `memoryStorage()` skips that round trip entirely. The file size limit below is
 * what makes this safe - it is unchanged at 5 MB per file, so peak memory for an
 * upload is bounded by (limit x concurrent uploads), never by the request size.
 *
 * The temp-file cleanup the controllers still perform is a no-op for files that
 * never reached disk: `fs.unlink` on a path that does not exist calls back with
 * an `ENOENT` error that every call site already discards.
 */
const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
  const allowedTypes = /jpeg|jpg|png|gif|webp/;
  const extname = allowedTypes.test(
    path.extname(file.originalname).toLowerCase()
  );
  const mimetype = allowedTypes.test(file.mimetype);

  if (extname && mimetype) {
    cb(null, true);
  } else {
    cb(new Error('Only image files (jpg, png, gif, webp) are allowed'));
  }
};

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter,
});

module.exports = upload;