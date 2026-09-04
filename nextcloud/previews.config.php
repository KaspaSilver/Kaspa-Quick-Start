<?php
/**
 * Previews, written by the Kaspa Quick Start stack.
 *
 * The Nextcloud image reads every *.config.php in this directory, so this sits
 * beside the config the container writes for itself rather than fighting it.
 *
 * Two things generate previews here and neither is on by default:
 *
 *   Imaginary   a container of its own, and what turns an iPhone photo into a
 *               thumbnail. Nextcloud sends it nothing until both
 *               preview_imaginary_url is set and OC\Preview\Imaginary is in the
 *               provider list -- it had been running with nothing pointed at
 *               it, doing nothing at all.
 *   ffmpeg      installed into this image, and used by OC\Preview\Movie, which
 *               Nextcloud disables by default. Without it a video has no
 *               thumbnail no matter what is installed.
 */
$CONFIG = [
    'enable_previews' => true,

    'enabledPreviewProviders' => [
        // Imaginary covers bmp, x-bitmap, png, jpeg, gif, heic, heif, svg+xml,
        // tiff, webp and illustrator, and does it out of process -- a large
        // photo cannot take the web server's memory down with it.
        'OC\\Preview\\Imaginary',
        'OC\\Preview\\ImaginaryPDF',

        // Video, via the ffmpeg in this image.
        'OC\\Preview\\Movie',

        // Cover art out of audio files.
        'OC\\Preview\\MP3',

        // The defaults, repeated on purpose: naming any provider replaces the
        // default set rather than adding to it, so leaving these out would lose
        // them.
        'OC\\Preview\\PNG',
        'OC\\Preview\\JPEG',
        'OC\\Preview\\GIF',
        'OC\\Preview\\BMP',
        'OC\\Preview\\XBitmap',
        'OC\\Preview\\WebP',
        'OC\\Preview\\Krita',
        'OC\\Preview\\MarkDown',
        'OC\\Preview\\TXT',
        'OC\\Preview\\OpenDocument',
    ],

    // Where Imaginary is on this stack's network. It is not published to the
    // host, so nothing outside the stack can reach it.
    'preview_imaginary_url' => 'http://nextcloud-imaginary:9000',

    // Bigger than the 256x256 default, because these are looked at on phone
    // screens that are not 256 pixels wide. Previews are cached, so the cost is
    // paid once per file.
    'preview_max_x' => 2048,
    'preview_max_y' => 2048,

    // A photo from a modern camera is comfortably over the 50MB default, and
    // over the limit means no preview at all rather than a slower one.
    'preview_max_filesize_image' => 256,
];

// Only when the stack generated one. An empty key on this side and a secret on
// Imaginary's is a pair that rejects every request.
$imaginaryKey = getenv('NEXTCLOUD_IMAGINARY_SECRET');
if ($imaginaryKey) {
    $CONFIG['preview_imaginary_key'] = $imaginaryKey;
}
