use browser_recall_daemon::{ConfigStore, DaemonConfig};
use objc2::{rc::Retained, runtime::Bool, MainThreadMarker};
use objc2_app_kit::{NSModalResponseCancel, NSModalResponseOK, NSOpenPanel};
use objc2_foundation::{
    NSData, NSHomeDirectory, NSString, NSURLBookmarkCreationOptions,
    NSURLBookmarkResolutionOptions, NSURL,
};
use std::{
    io,
    path::{Path, PathBuf},
};

pub fn app_home() -> PathBuf {
    PathBuf::from(NSHomeDirectory().to_string())
}

pub struct LibraryAccess {
    url: Retained<NSURL>,
}

impl LibraryAccess {
    pub async fn choose(
        app: &tauri::AppHandle,
        previous_path: PathBuf,
    ) -> Result<Option<(Self, PathBuf, Vec<u8>)>, String> {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        app.run_on_main_thread(move || {
            let _ = sender.send(Self::pick_folder(&previous_path));
        })
        .map_err(|error| error.to_string())?;
        receiver.await.map_err(|error| error.to_string())?
    }

    fn pick_folder(previous_path: &Path) -> Result<Option<(Self, PathBuf, Vec<u8>)>, String> {
        let main_thread =
            MainThreadMarker::new().ok_or("The folder picker needs the main thread")?;
        let panel = NSOpenPanel::openPanel(main_thread);
        panel.setTitle(Some(&NSString::from_str(
            "Choose Browser Recall Data Folder",
        )));
        panel.setCanChooseDirectories(true);
        panel.setCanChooseFiles(false);
        panel.setCanCreateDirectories(true);
        panel.setAllowsMultipleSelection(false);
        if let Some(path) = previous_path.to_str().filter(|path| !path.is_empty()) {
            panel.setDirectoryURL(Some(&NSURL::fileURLWithPath_isDirectory(
                &NSString::from_str(path),
                true,
            )));
        }
        let response = panel.runModal();
        if response == NSModalResponseCancel {
            return Ok(None);
        }
        if response != NSModalResponseOK {
            return Err("The folder picker could not be opened".into());
        }
        let url = panel.URL().ok_or("The folder picker returned no URL")?;
        let bookmark = Self::bookmark(&url)?;
        let (access, _) = Self::resolve(&bookmark)?;
        let path = access.path()?;
        Ok(Some((access, path, bookmark)))
    }

    pub fn restore(
        config_store: &ConfigStore,
        config: &mut DaemonConfig,
    ) -> Result<Option<Self>, String> {
        if config.data_dir.as_os_str().is_empty() {
            return Ok(None);
        }
        let bookmark = config
            .data_dir_bookmark
            .as_deref()
            .ok_or("Select the data folder again to grant Browser Recall access")?;
        let (access, stale) = Self::resolve(bookmark)?;
        let path = access.path()?;
        if stale || path != config.data_dir {
            let refreshed = stale.then(|| Self::bookmark(&access.url)).transpose()?;
            *config = config_store
                .update(|current| {
                    if current.data_dir_bookmark.as_deref() != Some(bookmark) {
                        return Err(io::Error::other(
                            "The data folder changed while restoring access",
                        ));
                    }
                    current.data_dir = path;
                    if let Some(bookmark) = refreshed {
                        current.data_dir_bookmark = Some(bookmark);
                    }
                    Ok(current.clone())
                })
                .map_err(|error| error.to_string())?;
        }
        Ok(Some(access))
    }

    fn bookmark(url: &NSURL) -> Result<Vec<u8>, String> {
        url.bookmarkDataWithOptions_includingResourceValuesForKeys_relativeToURL_error(
            NSURLBookmarkCreationOptions::WithSecurityScope,
            None,
            None,
        )
        .map(|data| data.to_vec())
        .map_err(|error| error.localizedDescription().to_string())
    }

    fn resolve(bookmark: &[u8]) -> Result<(Self, bool), String> {
        let mut stale = Bool::NO;
        // The bookmark and stale flag are live throughout the Foundation call.
        let url = unsafe {
            NSURL::URLByResolvingBookmarkData_options_relativeToURL_bookmarkDataIsStale_error(
                &NSData::with_bytes(bookmark),
                NSURLBookmarkResolutionOptions::WithSecurityScope
                    | NSURLBookmarkResolutionOptions::WithoutUI,
                None,
                &mut stale,
            )
        }
        .map_err(|error| error.localizedDescription().to_string())?;
        // Keep access active while the local data service can read or write the folder.
        if !unsafe { url.startAccessingSecurityScopedResource() } {
            return Err("Browser Recall could not access the selected data folder".into());
        }
        Ok((Self { url }, stale.as_bool()))
    }

    fn path(&self) -> Result<PathBuf, String> {
        let path = self.url.path().ok_or("The data folder URL has no path")?;
        let path = PathBuf::from(path.to_string());
        if !path.is_dir() {
            return Err("The selected data folder is unavailable".into());
        }
        Ok(path)
    }
}

impl Drop for LibraryAccess {
    fn drop(&mut self) {
        // Only successfully acquired URLs are stored in LibraryAccess.
        unsafe { self.url.stopAccessingSecurityScopedResource() };
    }
}
