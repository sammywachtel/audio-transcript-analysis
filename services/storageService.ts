import {
  ref,
  uploadBytes,
  uploadBytesResumable,
  getDownloadURL,
  deleteObject,
  getMetadata,
  UploadResult,
  UploadTask
} from 'firebase/storage';
import { storage } from '../firebase-config';

/**
 * StorageService - Handles Firebase Storage operations for audio files
 *
 * Audio files are stored in a user-specific path structure:
 *   audio/{userId}/{conversationId}.{extension}
 *
 * This structure enables:
 * 1. Security rules that enforce user isolation
 * 2. Easy cleanup when deleting a conversation
 * 3. Predictable paths for download URL generation
 *
 * Note: Download URLs from getDownloadURL() include a token and expire
 * after some time. For long-lived access, we store the path and
 * regenerate URLs on demand.
 */
export class StorageService {
  private readonly basePath = 'audio';

  /**
   * Generate the storage path for an audio file
   * Format: audio/{userId}/{conversationId}.{extension}
   */
  getAudioPath(userId: string, conversationId: string, fileName: string): string {
    // Extract extension from original filename
    const extension = fileName.split('.').pop() || 'mp3';
    return `${this.basePath}/${userId}/${conversationId}.${extension}`;
  }

  /**
   * Upload an audio file to Firebase Storage with real-time progress tracking
   * Returns the storage path and a cancel function
   */
  async uploadAudio(
    userId: string,
    conversationId: string,
    file: File,
    onProgress?: (progress: number) => void
  ): Promise<{ storagePath: string; cancel: () => void }> {
    const storagePath = this.getAudioPath(userId, conversationId, file.name);
    const storageRef = ref(storage, storagePath);

    console.log('[Storage] Uploading audio:', {
      path: storagePath,
      size: file.size,
      type: file.type
    });

    // Use uploadBytesResumable for real progress tracking
    const uploadTask: UploadTask = uploadBytesResumable(storageRef, file, {
      contentType: file.type || 'audio/mpeg',
      customMetadata: {
        originalFileName: file.name,
        uploadedAt: new Date().toISOString()
      }
    });

    // Wire up progress tracking
    const unsubscribe = uploadTask.on(
      'state_changed',
      (snapshot) => {
        const progress = (snapshot.bytesTransferred / snapshot.totalBytes) * 100;
        console.log('[Storage] Upload progress:', {
          path: storagePath,
          bytesTransferred: snapshot.bytesTransferred,
          totalBytes: snapshot.totalBytes,
          progress: `${progress.toFixed(1)}%`
        });
        onProgress?.(Math.round(progress));
      },
      (error) => {
        console.error('[Storage] Upload error:', error);
        throw error;
      }
    );

    // Wait for upload to complete
    await uploadTask;

    console.log('[Storage] Upload complete:', {
      path: storagePath
    });

    return { storagePath, cancel: unsubscribe };
  }

  /**
   * Upload an audio blob (from IndexedDB migration or processing)
   */
  async uploadAudioBlob(
    userId: string,
    conversationId: string,
    blob: Blob,
    fileName: string
  ): Promise<string> {
    const storagePath = this.getAudioPath(userId, conversationId, fileName);
    const storageRef = ref(storage, storagePath);

    console.log('[Storage] Uploading audio blob:', {
      path: storagePath,
      size: blob.size,
      type: blob.type
    });

    await uploadBytes(storageRef, blob, {
      contentType: blob.type || 'audio/mpeg',
      customMetadata: {
        originalFileName: fileName,
        uploadedAt: new Date().toISOString()
      }
    });

    return storagePath;
  }

  /**
   * Get a download URL for an audio file
   *
   * These URLs include a token and are long-lived but may expire.
   * We generate them on-demand rather than storing them.
   */
  async getAudioUrl(storagePath: string): Promise<string> {
    const storageRef = ref(storage, storagePath);

    try {
      const url = await getDownloadURL(storageRef);
      console.log('[Storage] Generated download URL for:', storagePath);
      return url;
    } catch (error: any) {
      if (error.code === 'storage/object-not-found') {
        console.warn('[Storage] Audio file not found:', storagePath);
        throw new Error('Audio file not found');
      }
      throw error;
    }
  }

  /**
   * Delete an audio file from Storage
   * Called when a conversation is deleted
   */
  async deleteAudio(storagePath: string): Promise<void> {
    const storageRef = ref(storage, storagePath);

    try {
      await deleteObject(storageRef);
      console.log('[Storage] Deleted audio file:', storagePath);
    } catch (error: any) {
      if (error.code === 'storage/object-not-found') {
        // File already gone, that's fine
        console.log('[Storage] Audio file already deleted:', storagePath);
        return;
      }
      throw error;
    }
  }

  /**
   * Check if an audio file exists in Storage
   */
  async audioExists(storagePath: string): Promise<boolean> {
    const storageRef = ref(storage, storagePath);

    try {
      await getMetadata(storageRef);
      return true;
    } catch (error: any) {
      if (error.code === 'storage/object-not-found') {
        return false;
      }
      throw error;
    }
  }

  /**
   * Get metadata for an audio file
   */
  async getAudioMetadata(storagePath: string): Promise<{
    size: number;
    contentType: string;
    timeCreated: string;
    customMetadata?: Record<string, string>;
  } | null> {
    const storageRef = ref(storage, storagePath);

    try {
      const metadata = await getMetadata(storageRef);
      return {
        size: metadata.size,
        contentType: metadata.contentType || 'audio/mpeg',
        timeCreated: metadata.timeCreated,
        customMetadata: metadata.customMetadata
      };
    } catch (error: any) {
      if (error.code === 'storage/object-not-found') {
        return null;
      }
      throw error;
    }
  }

  /**
   * Delete all audio files for a user
   * Used when a user deletes their account (future feature)
   *
   * Note: Firebase Storage doesn't support recursive deletes.
   * For production, this should be done via a Cloud Function that
   * lists and deletes files in batches.
   */
  async deleteAllUserAudio(userId: string): Promise<void> {
    console.warn(
      '[Storage] deleteAllUserAudio not implemented - requires Cloud Function for listing files'
    );
    // This would require listing all files under audio/{userId}/ and deleting each
    // Firebase Storage client SDK doesn't support listing, so we'd need a Cloud Function
  }
}

// Export singleton instance
export const storageService = new StorageService();
