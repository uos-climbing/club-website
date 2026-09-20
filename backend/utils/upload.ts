import type { Request } from 'express';
import multer from 'multer';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

export const imageFileFilter = (_req: Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
    const filetypes = /jpeg|jpg|png|webp|heic|heif/;
    const mimetype = filetypes.test(file.mimetype);
    const extname = filetypes.test(path.extname(file.originalname).toLowerCase());

    if (mimetype && extname) {
        return cb(null, true);
    }
    cb(new Error('Only images (jpeg, jpg, png, webp, heic, heif) are allowed!'));
};

export const memoryUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
    fileFilter: imageFileFilter
});

const diskStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, os.tmpdir());
    },
    filename: (req, file, cb) => {
        cb(
            null,
            'tmp-upload-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex') + path.extname(file.originalname)
        );
    }
});

export const diskUpload = multer({
    storage: diskStorage,
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit for high-res photos
    fileFilter: imageFileFilter
});
