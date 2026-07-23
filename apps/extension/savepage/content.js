/************************************************************************/
/*                                                                      */
/*      Save Page WE - Generic WebExtension - Content Pages             */
/*                                                                      */
/*      Javascript for Saving Content Pages (main frame)                */
/*                                                                      */
/*      Last Edit - 31 Mar 2023                                         */
/*                                                                      */
/*      Copyright (C) 2016-2023 DW-dev                                  */
/*                                                                      */
/*      Distributed under the GNU General Public License version 2      */
/*      See LICENCE.txt file and http://www.gnu.org/licenses/           */
/*                                                                      */
/************************************************************************/

/************************************************************************/
/*                                                                      */
/* Refer to Google Chrome developer documentation:                      */
/*                                                                      */
/* developer.chrome.com/docs/extensions/mv3/content_scripts             */
/* developer.chrome.com/docs/extensions/mv3/messaging                   */
/* developer.chrome.com/docs/extensions/mv3/xhr                         */
/*                                                                      */
/* developer.chrome.com/docs/extensions/mv3/match_patterns              */
/*                                                                      */
/* developer.chrome.com/docs/extensions/reference/runtime               */
/* developer.chrome.com/docs/extensions/reference/storage               */
/*                                                                      */
/************************************************************************/

/************************************************************************/
/*                                                                      */
/* Saving Pages in Background Tabs                                      */
/*                                                                      */
/* Using the window.setTimeout() function in the content script         */
/* causes long delays when saving a page in a background tab.           */
/* Browsers always increase the timeout to at least one second and      */
/* sometimes the timeout can be many seconds.                           */
/*                                                                      */
/* The solution is to send a message from the content script to the     */
/* background script requesting a delay and wait for the response.      */
/* The background script calls the window.setTimeout() function and     */
/* sends an asynchronous response when the timeout expires.             */
/*                                                                      */
/************************************************************************/

/************************************************************************/
/*                                                                      */
/* Lazy Load JS Libraries                                               */
/*                                                                      */
/* Libraries that manage lazy loading of images in <img> elements.      */
/*                                                                      */
/* lazysizes           data-src         data-srcset                     */
/*                                                                      */
/* lazyload.js         data-src         data-srcset                     */
/* (old version)       data-original    data-original-set               */
/*                                                                      */
/* Lozad               data-src         data-srcset                     */
/*                                                                      */
/* Vanilla Lazyload    data-src         data-srcset                     */
/*                                                                      */
/* Layzr.js            data-normal      data-srcset                     */
/*                                                                      */
/* blazy.js            data-src         -                               */
/*                                                                      */
/* lazyestload.js      data-src         data-srcset                     */
/*                                                                      */
/* yall.js             data-src         data-srcset                     */
/*                                                                      */
/*  responsivelyLazy    -                data-srcset                    */
/*                                                                      */
/************************************************************************/

/************************************************************************/
/*                                                                      */
/* CSS-in-JS Libraries                                                  */
/*                                                                      */
/* For <style> elements there may be rules in element.sheet.cssRules    */
/* that are not in element.textContent.                                 */
/*                                                                      */
/* This is often the case for CSS-in-JS libraries, for example:         */
/*                                                                      */
/* - Styled Components v3.1.6 Issue #1571                               */
/*   - ref. https://github.com/styled-components/                       */
/*          styled-components/issues/1571                               */
/*                                                                      */
/* - Styled Components >= v4 - data-styled attribute                    */
/*   - e.g. observationdeck.kinja.com pages                             */
/*                                                                      */
/* - Styled Components <= v3 - data-styled-components attribute         */
/*   - e.g. reddit.com pages                                            */
/*                                                                      */
/* - Styled Components >= v4 - data-styled attribute                    */
/*   - e.g. observationdeck.kinja.com pages                             */
/*                                                                      */
/* - Styled JSX - data-styled-jsx attribute                             */
/*   - e.g. www.flightstats.com pages                                   */
/*                                                                      */
/* - React Native - id="react-native-stylesheet" attribute              */
/*   - e.g. twitter.com pages                                           */
/*                                                                      */
/* - React-JSS or JSS - data-jss attribute                              */
/*   - e.g. https://www.dailykos.com                                    */
/*                                                                      */
/* - Glamor - data-glamor attribute                                     */
/*   - e.g. https://www.dailykos.com                                    */
/*                                                                      */
/* - Emotion - data-emotion attribute                                   */
/*   - not tested                                                       */
/*                                                                      */
/* - Aphrodite - data-aphrodite attribute                               */
/*   - not tested                                                       */
/*                                                                      */
/* - Styletron - data-styletron attribute                               */
/*   - not tested                                                       */
/*                                                                      */
/* - Unknown - data-lights                                              */
/*   - e.g. https://www.nytimes.com                                     */
/*                                                                      */
/************************************************************************/

/************************************************************************/
/*                                                                      */
/* Tab Page Type                                                        */
/*                                                                      */
/*  0 = Normal Page                                                     */
/*  1 = Saved Page                                                      */
/*  2 = Saved Page with Resource Loader                                 */
/*                                                                      */
/************************************************************************/

/************************************************************************/
/*                                                                      */
/* Tab Save State                                                       */
/*                                                                      */
/* -2 = Before Navigate                                                 */
/* -1 = Script loaded (page loaded)                                     */
/*  0 = Lazy Loads                                                      */
/*  1 = First Pass                                                      */
/*  2 = Second Pass                                                     */
/*  3 = Third Pass                                                      */
/*  4 = Remove Resource Loader                                          */
/*  5 = Extract Image/Audio/Video                                       */
/*  6 = Saved                                                           */
/*  7 = Removed                                                         */
/*  8 = Extracted                                                       */
/*                                                                      */
/************************************************************************/

"use strict";

/************************************************************************/

/* Global variables */

var isFirefox;

var platformOS;
var platformArch;

var installType;

var maxTotalSize;  /* MB */

var showWarning,showResources,promptComments,skipWarningsComments,useNewSaveMethod;
var loadLazyContent,lazyLoadType,loadLazyImages,retainCrossFrames,mergeCSSImages,executeScripts,removeUnsavedURLs,removeElements,rehideElements,includeInfoBar,includeSummary,formatHTML;
var saveHTMLAudioVideo,saveHTMLObjectEmbed,saveHTMLImagesAll;
var saveCSSImagesAll,saveCSSFontsWoff,saveCSSFontsAll,saveScripts;
var savedFileName,replaceSpaces,replaceChar,maxFileNameLength;
var saveDelayTime;
var lazyLoadScrollTime,lazyLoadShrinkTime;
var maxFrameDepth;
var maxResourceSize;
var maxResourceTime;
var allowPassive;
var crossOrigin;
var useAutomation;

var pageType = 0;
var saveState = -1;

var iframe;

var messagePanel,lazyloadPanel,unsavedPanel,commentsPanel,pageinfoPanel;  /* user interface panels */
var pageinfoBar,shadowLoader;  /* inserted in saved page */

var menuAction;
var savedItems;
var toggleLazy;
var extractSrcUrl;
var swapDevices;  /* from Print Edit WE*/
var multipleSaves;
var cspRestriction;
var captureId;

var skipLazyLoad,cancelSave;

var htmlCssText,bodyCssText,origScrollY;

var passNumber;

var frameKey = [];
var frameURL = [];
var frameHTML = [];
var frameFonts = [];

var resourceCount;

var resourceLocation = [];
var resourceReferrer = [];
var resourceMimeType = [];
var resourceCharSet = [];
var resourcePassive = [];
var resourceContent = [];
var resourceStatus = [];
var resourceReason = [];
var resourceRemembered = [];
var resourceReplaced = [];
var resourceCSSRemembered = [];  /* number of times CSS image remembered */
var resourceCSSFrameKeys = [];  /* keys of frames in which CSS image remembered */

var firstIconLocation;  /* location of first favicon in document head */
var rootIconLocation;  /* location of favicon in website root */

var enteredComments;

var htmlStrings = [];

var timeStart = [];
var timeFinish = [];

var shadowElements = ["audio","video","use"];  /* HTML & SVG elements that have built-in Shadow DOM */
var hrefSVGElements = ["a","altGlyph","animate","animateColor","animateMotion","animateTransform","cursor","discard","feImage","filter","font-face-uri","glyphRef","image",
                       "linearGradient","mpath","pattern","radialGradient","script","set","textPath","tref","use"];  /* SVG 1.1 & SVG 2 elements that can have xlink:href or href attribute */

var debugEnable = false;

/************************************************************************/

/* Initialize on script load — Browser Recall adaptation */
/* Hardcode options instead of reading from chrome.storage.local */

isFirefox = (typeof browser !== "undefined");
platformOS = navigator.platform.startsWith("Win") ? "win" : navigator.platform.startsWith("Linux") ? "linux" : "mac";
platformArch = "x86-64";
installType = "normal";
maxTotalSize = 200;

/* Options hardcoded for our use case */
showWarning = false;
showResources = false;
promptComments = false;
skipWarningsComments = true;
useNewSaveMethod = false;

loadLazyContent = false;
lazyLoadType = 0;
loadLazyImages = true;
retainCrossFrames = true;
mergeCSSImages = true;
executeScripts = false;
removeUnsavedURLs = false;
removeElements = true;
rehideElements = false;
includeInfoBar = false;
includeSummary = false;
formatHTML = true;

saveHTMLImagesAll = true;
saveHTMLAudioVideo = false;
saveHTMLObjectEmbed = false;
saveCSSImagesAll = true;
saveCSSFontsWoff = true;
saveCSSFontsAll = false;
saveScripts = false;

savedFileName = "%TITLE%";
replaceSpaces = false;
replaceChar = "-";
maxFileNameLength = 150;

saveDelayTime = 0;

lazyLoadScrollTime = 3;
lazyLoadShrinkTime = 3;

maxFrameDepth = 5;
maxResourceSize = 50;
maxResourceTime = 10;
allowPassive = false;
crossOrigin = 0;
useAutomation = false;

/* Shadow loader (compressed) for saved pages */
shadowLoader = "";

/* Add listeners — guard against duplicate registrations from re-injection */
if (!window.__savepageListenersAdded) {
    window.__savepageListenersAdded = true;
    addListeners();
}

/* Script loaded — notify background */
pageType = 0;
saveState = -1;
chrome.runtime.sendMessage({ type: "scriptLoaded", pagetype: pageType, savestate: saveState });

/************************************************************************/

/* Add listeners */

function addListeners()
{
    /* Message received listener */

    chrome.runtime.onMessage.addListener(
    function(message,sender,sendResponse)
    {
        var i;

        switch (message.type)
        {
            /* Messages from background page */

            case "getState":

                sendResponse({ pagetype: pageType, savestate: saveState });

                break;

            case "performAction":

                captureId = message.captureId;
                menuAction = message.menuaction;
                savedItems = message.saveditems;
                toggleLazy = message.togglelazy;
                extractSrcUrl = message.extractsrcurl;
                multipleSaves = message.multiplesaves;
                swapDevices = message.swapdevices;
                cspRestriction = message.csprestriction;

                cancelSave = false;

                /* Perform action */

                performAction();

                break;

            case "loadSuccess":

                if (message.captureId == captureId) loadSuccess(message.index,message.reason,message.content,message.mimetype,message.charset);

                break;

            case "loadFailure":

                if (message.captureId == captureId) loadFailure(message.index,message.reason);

                break;

            case "replyFrame":

                i = frameKey.length;

                frameKey[i] = message.key;
                frameURL[i] = message.url;
                frameHTML[i] = message.html;
                frameFonts[i] = message.fonts;

                break;

            case "cancelSave":

                if (message.captureId == captureId) cancelSave = true;

                break;
        }
    });
}

/************************************************************************/

/* Perform action function */

function performAction()
{
    if (menuAction <= 1)  /* save page */
    {
        if (loadLazyImages) forceLazyImages();

        initializeBeforeSave();
    }
    else
    {
        console.warn("[savepage] Unsupported menuAction:", menuAction);

        saveState = -1;

        chrome.runtime.sendMessage({ type: "saveExit", captureId: captureId, pagetype: pageType, savestate: saveState });
    }
}

/************************************************************************/

/* Load lazy content */

function forceLazyContent()
{
    var origscrolly,scrolly,panel,scalex,scaley,originx,originy,lastscrollheight;
    var starttime,endtime;
    
    skipLazyLoad = false;
    
    if (lazyLoadType == 0)  /* scroll page */
    {
        saveState = 0;  /* lazy load */
        
        chrome.runtime.sendMessage({ type: "stateChanged", pagetype: pageType, savestate: saveState });
        
        showLazyLoad();
        
        starttime = performance.now();
        
        origscrolly = window.scrollY;
        scrolly = 0;
        
        window.scrollTo(0,scrolly);
        
        if (debugEnable) console.log("INITIAL  -  Inner Height: " + window.innerHeight + "  Scroll Height: " + document.body.scrollHeight + "  Scroll Y: " + scrolly);
        
        chrome.runtime.sendMessage({ type: "setDelay", milliseconds: lazyLoadScrollTime*1000 },  /* allow time for first lazy loads to complete */
        function timer(response)
        {
            if (scrolly < document.documentElement.scrollHeight && !skipLazyLoad && !cancelSave)
            {
                if (debugEnable) console.log("GROWING  -  Inner Height: " + window.innerHeight + "  Scroll Height: " + document.body.scrollHeight + "  Scroll Y: " + scrolly);
                
                scrolly += window.innerHeight;
                
                window.scrollTo(0,scrolly);
                
                chrome.runtime.sendMessage({ type: "setDelay", milliseconds: lazyLoadScrollTime*1000 },  /* allow time for some more lazy loads to complete */
                function(response)
                {
                    timer();
                });
            }
            else
            {
                if (debugEnable) console.log("WAITING  -  Inner Height: " + window.innerHeight + "  Scroll Height: " + document.body.scrollHeight + "  Scroll Y: " + scrolly);
                
                window.scrollTo(0,document.documentElement.scrollHeight-window.innerHeight-10);
                window.scrollTo(0,document.documentElement.scrollHeight);
                
                chrome.runtime.sendMessage({ type: "setDelay", milliseconds: 500+lazyLoadScrollTime*1000 },  /* allow time for final lazy loads to complete */
                function(response)
                {
                    if (debugEnable) console.log("FINISHED -  Inner Height: " + window.innerHeight + "  Scroll Height: " + document.body.scrollHeight + "  Scroll Y: " + scrolly);
                    
                    endtime = performance.now();
                    
                    if (debugEnable) console.log("LAZY LOAD TIME: " + (endtime-starttime)/1000 + "secs");
                    
                    window.scrollTo(0,origscrolly);
                    
                    panel = document.getElementById("savepage-lazyload-panel-container");
                    
                    if (panel != null) document.documentElement.removeChild(panel);
                    
                    if (cancelSave)
                    {
                        saveState = -1;
                        
                        chrome.runtime.sendMessage({ type: "saveExit", captureId: captureId, pagetype: pageType, savestate: saveState });
                    }
                    else
                    {
                        if (loadLazyImages) forceLazyImages();
                        
                        initializeBeforeSave();
                    }
                });
            }
        }); 
    }
    else if (lazyLoadType == 1)  /* shrink page */
    {
        saveState = 0;  /* lazy load */
        
        chrome.runtime.sendMessage({ type: "stateChanged", pagetype: pageType, savestate: saveState });
        
        showLazyLoad();
        
        starttime = performance.now();
        
        htmlCssText = document.documentElement.style.cssText;
        bodyCssText = document.body.style.cssText;
        origScrollY = window.scrollY;
        
        scalex = 400/document.body.scrollWidth;
        scaley = 0.025;
        
        originx = window.innerWidth/2;
        originy = 10;
        
        window.scrollTo(0,document.body.scrollHeight);  /* trigger lazy load scripts in page */
        window.scrollTo(0,0);
        
        document.documentElement.style.setProperty("background","#FFFFFF","important");
        
        document.body.style.setProperty("transform","scaleX(" + scalex + ") scaleY(" + scaley + ")","important");
        document.body.style.setProperty("visibility","hidden","important");
        
        chrome.runtime.sendMessage({ type: "setDelay", milliseconds: 500+lazyLoadShrinkTime*1000 },  /* allow time for page to settle after scroll - e.g. page with floating top bar that resizes when page scrolls */
        function(response)
        {
            document.body.style.removeProperty("visibility");
            document.body.style.setProperty("transform-origin",originx + "px " + originy + "px","important");
            
            lastscrollheight = document.body.scrollHeight;
            
            window.scrollTo(0,document.body.scrollHeight);  /* trigger lazy load scripts in page */
            window.scrollTo(0,0);
            
            if (debugEnable) console.log("INITIAL  -  Inner Height: " + window.innerHeight + "  Scroll Height: " + document.body.scrollHeight + "  Scale: " + scaley);
            
            chrome.runtime.sendMessage({ type: "setDelay", milliseconds: 500+lazyLoadShrinkTime*1000 },  /* allow time for first lazy loads to complete */
            function timer(response)
            {
                if (document.body.scrollHeight > lastscrollheight && document.body.scrollHeight*scaley < window.innerHeight && !skipLazyLoad && !cancelSave)
                {
                    if (debugEnable) console.log("GROWING  -  Inner Height: " + window.innerHeight + "  Scroll Height: " + document.body.scrollHeight + "  Scale: " + scaley);
                    
                    lastscrollheight = document.body.scrollHeight;
                    
                    window.scrollTo(0,document.body.scrollHeight);
                    window.scrollTo(0,0);
                    
                    chrome.runtime.sendMessage({ type: "setDelay", milliseconds: lazyLoadShrinkTime*1000 },  /* allow time for some more lazy loads to complete */
                    function(response)
                    {
                        timer();
                    });
                }
                else
                {
                    if (debugEnable) console.log("WAITING  -  Inner Height: " + window.innerHeight + "  Scroll Height: " + document.body.scrollHeight + "  Scale: " + scaley);
                    
                    window.scrollTo(0,document.body.scrollHeight);
                    window.scrollTo(0,0);
                    
                    chrome.runtime.sendMessage({ type: "setDelay", milliseconds: 500+lazyLoadShrinkTime*1000 },  /* allow time for final lazy loads to complete */
                    function(response)
                    {
                        if (debugEnable) console.log("FINISHED -  Inner Height: " + window.innerHeight + "  Scroll Height: " + document.body.scrollHeight + "  Scale: " + scaley);
                        
                        endtime = performance.now();
                        
                        if (debugEnable) console.log("LAZY LOAD TIME: " + (endtime-starttime)/1000 + "secs");
                        
                        panel = document.getElementById("savepage-lazyload-panel-container");
                        
                        if (panel != null) document.documentElement.removeChild(panel);
                        
                        if (skipLazyLoad || cancelSave) undoShrinkPage();
                        
                        if (cancelSave)
                        {
                            saveState = -1;
                            
                            chrome.runtime.sendMessage({ type: "saveExit", captureId: captureId, pagetype: pageType, savestate: saveState });
                        }
                        else
                        {
                            if (loadLazyImages) forceLazyImages();
                            
                            initializeBeforeSave();
                        }
                    });
                }
            });
        });
    }
}

function forceLazyImages()
{
    document.querySelectorAll("img").forEach(
    function (element)
    {
        /* Force loading of images with loading="lazy" attributes */
        
        if (element.getAttribute("loading") == "lazy")
        {
            element.removeAttribute("loading");
            element.setAttribute("data-savepage-loading","lazy");
        }
        
        /* Force loading of images managed by lazy load JS libraries */
        /* Changes are the same as if the page was scrolled by the user */
        
        if (element.getAttribute("data-src")) element.setAttribute("src",element.getAttribute("data-src"));
        else if (element.getAttribute("data-original")) element.setAttribute("src",element.getAttribute("data-original"));
        else if (element.getAttribute("data-normal")) element.setAttribute("src",element.getAttribute("data-normal"));
        
        if (element.getAttribute("data-srcset")) element.setAttribute("srcset",element.getAttribute("data-srcset"));
        else if (element.getAttribute("data-original-set")) element.setAttribute("srcset",element.getAttribute("data-original-set"));
    });
}

/* showLazyLoad — stripped (Browser Recall: no UI panels) */

/************************************************************************/

/* Initialize before save */

function initializeBeforeSave()
{
    /* Initialize resources */
    
    frameKey.length = 0;
    frameURL.length = 0;
    frameHTML.length = 0;
    frameFonts.length = 0;
    
    resourceLocation.length = 0;
    resourceReferrer.length = 0;
    resourceMimeType.length = 0;
    resourceCharSet.length = 0;
    resourcePassive.length = 0;
    resourceContent.length = 0;
    resourceStatus.length = 0;
    resourceReason.length = 0;
    resourceRemembered.length = 0;
    resourceReplaced.length = 0;
    resourceCSSRemembered.length = 0;
    resourceCSSFrameKeys.length = 0;
    
    firstIconLocation = "";
    rootIconLocation = "";
    
    enteredComments = "";
    
    htmlStrings.length = 0;
    
    htmlStrings[0] = "\uFEFF";  /* UTF-8 Byte Order Mark (BOM) - 0xEF 0xBB 0xBF */
    
    /* Identify all frames */
    
    chrome.runtime.sendMessage({ type: "requestFrames" });
    
    chrome.runtime.sendMessage({ type: "setDelay", milliseconds: 200 },  /* allow time for all frames to reply */
    function(response)
    {
        var i;
        
        // for (i = 0; i < frameKey.length; i++)
        // {
            // console.log("FRAME - " + (" " + i).substr(-2) + " - " + (frameKey[i] + "              ").substr(0,14) + " - " +
                        // (frameURL[i] + "                                                            ").replace(/\:/g,"").substr(0,80));
        // }
        
        gatherStyleSheets();
    });
}

/************************************************************************/

/* First Pass - to find external style sheets and load into arrays */

function gatherStyleSheets()
{
    passNumber = 1;
    
    saveState = 1;  /* first pass */
    
    chrome.runtime.sendMessage({ type: "stateChanged", pagetype: pageType, savestate: saveState });
    
    timeStart[1] = performance.now();
    
    findStyleSheets(0,window,document.documentElement);
    
    timeFinish[1] = performance.now();
    
    loadResources();
}

function findStyleSheets(depth,frame,element)
{
    var i,baseuri,charset,csstext,regex,parser,framedoc,shadowroot;
    var matches = [];
    
    /* External style sheet imported in <style> element */
    
    if (element.localName == "style")
    {
        if (!element.disabled)
        {
            csstext = element.textContent;
            
            baseuri = element.ownerDocument.baseURI;
            
            charset = element.ownerDocument.characterSet;
            
            regex = /@import\s*(?:url\(\s*)?((?:"[^"]+")|(?:'[^']+')|(?:[^\s);]+))(?:\s*\))?\s*;/gi;  /* @import url() */
            
            while ((matches = regex.exec(csstext)) != null)
            {
                matches[1] = removeQuotes(matches[1]);
                
                if (replaceableResourceURL(matches[1]))
                {
                    rememberURL(matches[1],baseuri,"text/css",charset,false);
                }
            }
        }
    }
    
    /* External style sheet referenced in <link> element */
    
    else if (element.localName == "link" && !(element.parentElement instanceof SVGElement))  /* <link> is invalid inside <svg> */
    {
        if (element.rel.toLowerCase().indexOf("stylesheet") >= 0 && element.getAttribute("href"))
        {
            if (!element.disabled)
            {
                if (replaceableResourceURL(element.href))
                {
                    baseuri = element.ownerDocument.baseURI;
                    
                    if (element.charset != "") charset = element.charset;
                    else charset = element.ownerDocument.characterSet;
                    
                    rememberURL(element.href,baseuri,"text/css",charset,false);
                }
            }
        }
    }
    
    /* Handle nested frames and child elements */
    
    if (element.localName == "iframe" || element.localName == "frame")  /* frame elements */
    {
        if (depth < maxFrameDepth)
        {
            try
            {
                if (element.contentDocument.documentElement != null)  /* in case web page not fully loaded before finding */
                {
                    findStyleSheets(depth+1,element.contentWindow,element.contentDocument.documentElement);
                }
            }
            catch (e)  /* attempting cross-domain web page access */
            {
                if (retainCrossFrames)
                {
                    for (i = 0; i < frameKey.length; i++)
                    {
                        if (frameKey[i] == element.getAttribute("data-savepage-key")) break;
                    }
                    
                    if (i != frameKey.length)
                    {
                        parser = new DOMParser();
                        framedoc = parser.parseFromString(frameHTML[i],"text/html");
                        
                        findStyleSheets(depth+1,null,framedoc.documentElement);
                    }
                }
            }
        }
    }
    else
    {
        /* Handle shadow child elements */
        
        if (isFirefox) shadowroot = element.shadowRoot || element.openOrClosedShadowRoot;
        else shadowroot = element.shadowRoot || ((chrome.dom && element instanceof HTMLElement) ? chrome.dom.openOrClosedShadowRoot(element) : null);
        
        if (shadowroot != null)
        {
            if (shadowElements.indexOf(element.localName) < 0)  /* ignore elements with built-in Shadow DOM */
            {
                for (i = 0; i < shadowroot.children.length; i++)
                    if (shadowroot.children[i] != null)  /* in case web page not fully loaded before finding */
                        findStyleSheets(depth,frame,shadowroot.children[i]);
            }
        }
        
        /* Handle normal child elements */
        
        for (i = 0; i < element.children.length; i++)
            if (element.children[i] != null)  /* in case web page not fully loaded before finding */
                findStyleSheets(depth,frame,element.children[i]);
    }
}

/************************************************************************/

/* Second Pass - to find other external resources and load into arrays */

function gatherOtherResources()
{
    var loadedfonts = [];
    
    passNumber = 2;
    
    saveState = 2;  /* second pass */
    
    chrome.runtime.sendMessage({ type: "stateChanged", pagetype: pageType, savestate: saveState });
    
    timeStart[2] = performance.now();
    
    document.fonts.forEach(  /* CSS Font Loading Module */
    function(font)
    {
        if (font.status == "loaded")  /* font is being used in this document */
        {
            loadedfonts.push({ family: font.family, weight: font.weight, style: font.style, stretch: font.stretch });
        }
    });
    
    findOtherResources(0,window,document.documentElement,false,false,loadedfonts,"0");
    
    timeFinish[2] = performance.now();
    
    loadResources();
}

function findOtherResources(depth,frame,element,crossframe,nosrcframe,loadedfonts,framekey)
{
    var i,j,displayed,style,csstext,baseuri,charset,dupelement,dupsheet,currentsrc,passive,documenturi,location,origurl,newurl,subframekey,parser,framedoc,shadowroot;
    var subloadedfonts = [];
    
    /* Determine if element is displayed */
    
    if (crossframe)
    {
        /* In a cross-origin frame, the document created by DOMParser */
        /* does not have an associated frame window, which means that */
        /* the window.getComputedStyle() function cannot be called.   */
        
        /* Assume all elements are displayed and force saving of all CSS images */
        
        displayed = true;
    }
    else if ((style = frame.getComputedStyle(element)) == null) displayed = true;  /* should not happen */
    else
    {
        displayed = (style.getPropertyValue("display") != "none");  /* element not collapsed */
        
        /* External images referenced in any element's computed style */
        
        if ((savedItems == 0 || savedItems == 1 || (savedItems == 2 && !saveCSSImagesAll)) && displayed)
        {
            csstext = "";
            
            csstext += style.getPropertyValue("background-image") + " ";
            csstext += style.getPropertyValue("border-image-source") + " ";
            csstext += style.getPropertyValue("list-style-image") + " ";
            csstext += style.getPropertyValue("cursor") + " ";
            csstext += style.getPropertyValue("filter") + " ";
            csstext += style.getPropertyValue("clip-path") + " ";
            csstext += style.getPropertyValue("mask-image") + " ";
            csstext += style.getPropertyValue("-webkit-mask-image") + " ";
            
            style = frame.getComputedStyle(element,"::before");
            csstext += style.getPropertyValue("background-image") + " ";
            csstext += style.getPropertyValue("border-image-source") + " ";
            csstext += style.getPropertyValue("list-style-image") + " ";
            csstext += style.getPropertyValue("cursor") + " ";
            csstext += style.getPropertyValue("content") + " ";
            csstext += style.getPropertyValue("filter") + " ";
            csstext += style.getPropertyValue("clip-path") + " ";
            csstext += style.getPropertyValue("mask-image") + " ";
            csstext += style.getPropertyValue("-webkit-mask-image") + " ";
            
            style = frame.getComputedStyle(element,"::after");
            csstext += style.getPropertyValue("background-image") + " ";
            csstext += style.getPropertyValue("border-image-source") + " ";
            csstext += style.getPropertyValue("list-style-image") + " ";
            csstext += style.getPropertyValue("cursor") + " ";
            csstext += style.getPropertyValue("content") + " ";
            csstext += style.getPropertyValue("filter") + " ";
            csstext += style.getPropertyValue("clip-path") + " ";
            csstext += style.getPropertyValue("mask-image") + " ";
            csstext += style.getPropertyValue("-webkit-mask-image") + " ";
            
            style = frame.getComputedStyle(element,"::first-letter");
            csstext += style.getPropertyValue("background-image") + " ";
            csstext += style.getPropertyValue("border-image-source") + " ";
            
            style = frame.getComputedStyle(element,"::first-line");
            csstext += style.getPropertyValue("background-image") + " ";
            
            baseuri = element.ownerDocument.baseURI;
            
            rememberCSSImageURLs(csstext,baseuri,framekey);
        }
    }
    
    /* External images referenced in any element's style attribute */
    
    if (element.hasAttribute("style"))
    {
        if ((savedItems == 2 && saveCSSImagesAll) || crossframe)
        {
            csstext = element.getAttribute("style");
            
            baseuri = element.ownerDocument.baseURI;
            
            rememberCSSImageURLs(csstext,baseuri,framekey);
        }
    }
    
    /* External script referenced in <script> element */
    
    if (element.localName == "script")
    {
        if ((savedItems == 2 && saveScripts) && !crossframe && !nosrcframe)
        {
            if (element.getAttribute("src"))
            {
                if (replaceableResourceURL(element.src))
                {
                    baseuri = element.ownerDocument.baseURI;
                    
                    if (element.charset != "") charset = element.charset;
                    else charset = element.ownerDocument.characterSet;
                    
                    rememberURL(element.src,baseuri,"text/javascript",charset,false);
                }
            }
        }
    }
    
    /* External images or fonts referenced in <style> element */
    
    else if (element.localName == "style")
    {
        if (!element.disabled)
        {
            if (element.hasAttribute("data-savepage-sheetrules")) csstext = element.getAttribute("data-savepage-sheetrules");
            else
            {
                try
                {
                    /* Count rules in element.textContent by creating duplicate element */
                    
                    dupelement = element.ownerDocument.createElement("style");
                    dupelement.textContent = element.textContent;
                    element.ownerDocument.body.appendChild(dupelement);
                    dupsheet = dupelement.sheet;
                    dupelement.remove();
                    
                    /* There may be rules in element.sheet.cssRules that are not in element.textContent */
                    /* For example if the page uses CSS-in-JS Libraries */
                    
                    if (dupsheet.cssRules.length != element.sheet.cssRules.length)
                    {
                        csstext = "";
                        
                        for (i = 0; i < element.sheet.cssRules.length; i++)
                            csstext += element.sheet.cssRules[i].cssText + "\n";
                    }
                    else csstext = element.textContent;
                }
                catch (e)  /* sheet.cssRules does not exist or cross-origin style sheet */
                {
                    csstext = element.textContent;
                }
            }
            
            baseuri = element.ownerDocument.baseURI;
            
            rememberCSSURLsInStyleSheet(csstext,baseuri,crossframe,loadedfonts,[],framekey);
        }
    }
    
    /* External images or fonts referenced in <link> element */
    /* External icon referenced in <link> element */
    
    else if (element.localName == "link" && !(element.parentElement instanceof SVGElement))  /* <link> is invalid inside <svg> */
    {
        if (element.rel.toLowerCase().indexOf("stylesheet") >= 0 && element.getAttribute("href"))
        {
            if (!element.disabled)
            {
                if (replaceableResourceURL(element.href))
                {
                    baseuri = element.ownerDocument.baseURI;
                    
                    if (baseuri != null)
                    {
                        location = resolveURL(element.href,baseuri);
                        
                        if (location != null)
                        {
                            location = removeFragment(location);
                            
                            for (i = 0; i < resourceLocation.length; i++)
                                if (resourceLocation[i] == location && resourceStatus[i] == "success") break;
                            
                            if (i < resourceLocation.length)  /* style sheet found */
                            {
                                csstext = resourceContent[i];
                                
                                baseuri = element.href;
                                
                                rememberCSSURLsInStyleSheet(csstext,baseuri,crossframe,loadedfonts,[location],framekey);
                            }
                        }
                    }
                }
            }
        }
        else if ((element.rel.toLowerCase() == "icon" || element.rel.toLowerCase() == "shortcut icon") && element.getAttribute("href"))
        {
            if (replaceableResourceURL(element.href))
            {
                baseuri = element.ownerDocument.baseURI;
                
                rememberURL(element.href,baseuri,"image/vnd.microsoft.icon","",false);
                
                if (firstIconLocation == "")
                {
                    location = resolveURL(element.href,baseuri);
                    
                    if (location != null) firstIconLocation = location;
                }
            }
        }
    }
    
    /* External location referenced in <a> or <area> element */
    
    else if ((element.localName == "a" && element instanceof HTMLElement) || element.localName == "area")
    {
    }
    
    /* External image referenced in <body> element */
    
    else if (element.localName == "body")
    {
        if (element.getAttribute("background"))
        {
            if (savedItems == 1 || (savedItems == 2 && saveHTMLImagesAll) ||
                (savedItems == 0 || (savedItems == 2 && !saveHTMLImagesAll)) && displayed)
            {
                if (replaceableResourceURL(element.background))
                {
                    baseuri = element.ownerDocument.baseURI;
                    
                    rememberURL(element.background,baseuri,"image/png","",false);
                }
            }
        }
    }
    
    /* External image referenced in <img> element - can be inside <picture> element */
    
    else if (element.localName == "img")
    {
        /* currentSrc is set from src or srcset attributes on this <img> element */
        /* or from srcset attribute on <source> element inside <picture> element */
        
        /* Firefox - workaround because element.currentSrc may be empty string in cross-origin frames */
        
        currentsrc = (element.currentSrc != "") ? element.currentSrc : (element.getAttribute("src") ? element.src : "");
        
        /* Chrome - workaround because element.currentSrc may have wrong fragment identifier for SVG images */
        
        currentsrc = (element.currentSrc.indexOf("#") < 0) ? element.currentSrc : (element.getAttribute("src") ? element.src : "");
        
        if (currentsrc != "")
        {
            if (savedItems == 1 || (savedItems == 2 && saveHTMLImagesAll) ||
                (savedItems == 0 || (savedItems == 2 && !saveHTMLImagesAll)) && displayed)
            {
                if (replaceableResourceURL(currentsrc))
                {
                    baseuri = element.ownerDocument.baseURI;
                    
                    passive = !((element.parentElement && element.parentElement.localName == "picture") || element.hasAttribute("srcset") || element.hasAttribute("crossorigin"));
                    
                    rememberURL(currentsrc,baseuri,"image/png","",passive);
                }
            }
        }
    }
    
    /* External image referenced in <input> element */
    
    else if (element.localName == "input")
    {
        if (element.type.toLowerCase() == "image" && element.getAttribute("src"))
        {
            if (savedItems == 1 || (savedItems == 2 && saveHTMLImagesAll) ||
                (savedItems == 0 || (savedItems == 2 && !saveHTMLImagesAll)) && displayed)
            {
                if (replaceableResourceURL(element.src))
                {
                    baseuri = element.ownerDocument.baseURI;
                    
                    rememberURL(element.src,baseuri,"image/png","",false);
                }
            }
        }
    }
    
    /* External audio referenced in <audio> element */
    
    else if (element.localName == "audio")
    {
        if (element.getAttribute("src"))
        {
            if (element.src == element.currentSrc)
            {
                if (savedItems == 1 || (savedItems == 2 && saveHTMLAudioVideo))
                {
                    if (replaceableResourceURL(element.src))
                    {
                        baseuri = element.ownerDocument.baseURI;
                        
                        passive = !element.hasAttribute("crossorigin");
                        
                        rememberURL(element.src,baseuri,"audio/mpeg","",passive);
                    }
                }
            }
        }
    }
    
    /* External video and image referenced in <video> element */
    
    else if (element.localName == "video")
    {
        if (element.getAttribute("src"))
        {
            if (element.src == element.currentSrc)
            {
                if (savedItems == 1 || (savedItems == 2 && saveHTMLAudioVideo))
                {
                    if (replaceableResourceURL(element.src))
                    {
                        baseuri = element.ownerDocument.baseURI;
                        
                        passive = !element.hasAttribute("crossorigin");
                        
                        rememberURL(element.src,baseuri,"video/mp4","",passive);
                    }
                }
            }
        }
        
        if (element.getAttribute("poster"))
        {
            if (savedItems == 1 || (savedItems == 2 && saveHTMLAudioVideo))
            {
                if (savedItems == 1 || (savedItems == 2 && saveHTMLImagesAll) ||
                    (savedItems == 0 || (savedItems == 2 && !saveHTMLImagesAll)) && displayed)
                {
                    if (replaceableResourceURL(element.poster))
                    {
                        baseuri = element.ownerDocument.baseURI;
                        
                        rememberURL(element.poster,baseuri,"image/png","",false);
                    }
                }
            }
        }
    }
    
    /* External audio/video/image referenced in <source> element */
    
    else if (element.localName == "source")
    {
        if (element.parentElement)
        {
            if (element.parentElement.localName == "audio" || element.parentElement.localName == "video")
            {
                if (element.getAttribute("src"))
                {
                    if (element.src == element.parentElement.currentSrc)
                    {
                        if (savedItems == 1 || (savedItems == 2 && saveHTMLAudioVideo))
                        {
                            if (replaceableResourceURL(element.src))
                            {
                                baseuri = element.ownerDocument.baseURI;
                                
                                passive = !element.parentElement.hasAttribute("crossorigin");
                                
                                if (element.parentElement.localName == "audio") rememberURL(element.src,baseuri,"audio/mpeg","",passive);
                                else if (element.parentElement.localName == "video") rememberURL(element.src,baseuri,"video/mp4","",passive);
                            }
                        }
                    }
                }
            }
        }
    }
    
    /* External subtitles referenced in <track> element */
    
    else if (element.localName == "track")
    {
        if (element.getAttribute("src"))
        {
            if (savedItems == 1 || (savedItems == 2 && saveHTMLAudioVideo))
            {
                if (replaceableResourceURL(element.src))
                {
                    baseuri = element.ownerDocument.baseURI;
                    
                    charset = element.ownerDocument.characterSet;
                    
                    rememberURL(element.src,baseuri,"text/vtt",charset,false);
                }
            }
        }
    }
    
    /* External data referenced in <object> element */
    
    else if (element.localName == "object")
    {
        if (element.getAttribute("data"))
        {
            if (savedItems == 1 || (savedItems == 2 && saveHTMLObjectEmbed))
            {
                if (replaceableResourceURL(element.data))
                {
                    baseuri = element.ownerDocument.baseURI;
                    
                    rememberURL(element.data,baseuri,"application/octet-stream","",false);
                }
            }
        }
    }
    
    /* External data referenced in <embed> element */
    
    else if (element.localName == "embed")
    {
        if (element.getAttribute("src"))
        {
            if (savedItems == 1 || (savedItems == 2 && saveHTMLObjectEmbed))
            {
                if (replaceableResourceURL(element.src))
                {
                    baseuri = element.ownerDocument.baseURI;
                    
                    rememberURL(element.src,baseuri,"application/octet-stream","",false);
                }
            }
        }
    }
    
    /* SVG - External location referenced in <a> element */
    
    else if (element.localName == "a" && element instanceof SVGElement)
    {
    }
    
    /* SVG - External resource referenced in other SVG elements */
    
    else if (hrefSVGElements.indexOf(element.localName) >= 0 && element instanceof SVGElement)
    {
        if (element.getAttribute("href") || element.getAttribute("xlink:href"))
        {
            baseuri = element.ownerDocument.baseURI;
            
            documenturi = element.ownerDocument.documentURI;
            
            origurl = element.getAttribute("href") || element.getAttribute("xlink:href");
            
            newurl = adjustURL(origurl,baseuri,documenturi);
            
            if (newurl.substr(0,1) != "#")  /* not fragment only */
            {
                if (replaceableResourceURL(element.href.baseVal))
                {
                    charset = element.ownerDocument.characterSet;
                    
                    rememberURL(element.href.baseVal,baseuri,"image/svg+xml",charset,false);
                }
            }
        }
    }
    
    /* Handle nested frames and child elements */
    
    if (element.localName == "iframe" || element.localName == "frame")  /* frame elements */
    {
        if (depth < maxFrameDepth)
        {
            if (element.localName == "iframe") nosrcframe = nosrcframe || (!element.getAttribute("src") && !element.getAttribute("srcdoc"));
            else nosrcframe = nosrcframe || !element.getAttribute("src");
            
            subframekey = element.getAttribute("data-savepage-key");
            
            try
            {
                if (element.contentDocument.documentElement != null)  /* in case web page not fully loaded before finding */
                {
                    element.contentDocument.fonts.forEach(  /* CSS Font Loading Module */
                    function(font)
                    {
                        if (font.status == "loaded")  /* font is being used in this document */
                        {
                            subloadedfonts.push({ family: font.family, weight: font.weight, style: font.style, stretch: font.stretch });
                        }
                    });
                    
                    findOtherResources(depth+1,element.contentWindow,element.contentDocument.documentElement,crossframe,nosrcframe,subloadedfonts,subframekey);
                }
            }
            catch (e)  /* attempting cross-domain web page access */
            {
                if (retainCrossFrames)
                {
                    for (i = 0; i < frameKey.length; i++)
                    {
                        if (frameKey[i] == subframekey) break;
                    }
                    
                    if (i != frameKey.length)
                    {
                        parser = new DOMParser();
                        framedoc = parser.parseFromString(frameHTML[i],"text/html");
                        
                        findOtherResources(depth+1,null,framedoc.documentElement,true,nosrcframe,frameFonts[i],subframekey);
                    }
                }
            }
        }
    }
    else
    {
        /* Handle shadow child elements */
        
        if (isFirefox) shadowroot = element.shadowRoot || element.openOrClosedShadowRoot;
        else shadowroot = element.shadowRoot || ((chrome.dom && element instanceof HTMLElement) ? chrome.dom.openOrClosedShadowRoot(element) : null);
        
        if (shadowroot != null)
        {
            if (shadowElements.indexOf(element.localName) < 0)  /* ignore elements with built-in Shadow DOM */
            {
                for (i = 0; i < shadowroot.children.length; i++)
                    if (shadowroot.children[i] != null)  /* in case web page not fully loaded before finding */
                        findOtherResources(depth,frame,shadowroot.children[i],crossframe,nosrcframe,loadedfonts,framekey);
            }
        }
        
        /* Handle normal child elements */
        
        for (i = 0; i < element.children.length; i++)
            if (element.children[i] != null)  /* in case web page not fully loaded before finding */
                findOtherResources(depth,frame,element.children[i],crossframe,nosrcframe,loadedfonts,framekey);
                
        /* Remember location of favicon in website root */
        
        if (element.localName == "head" && depth == 0)
        {
            if (firstIconLocation == "")
            {
                baseuri = element.ownerDocument.baseURI;
                
                rememberURL("/favicon.ico",baseuri,"image/vnd.microsoft.icon","",false);
                
                location = resolveURL("/favicon.ico",baseuri);
                
                if (location != null) rootIconLocation = location;
            }
        }
    }
}

function rememberCSSURLsInStyleSheet(csstext,baseuri,crossframe,loadedfonts,importstack,framekey)
{
    var i,regex,location,fontfamily,fontweight,fontstyle,fontstretch,fontmatches;
    var includeall,includewoff,usedfilefound,wofffilefound,srcregex,urlregex,fontfiletype;
    var matches = [];
    var propmatches = [];
    var srcmatches = [];
    var urlmatches = [];
    var fontweightvalues = ["normal","bold","bolder","lighter","100","200","300","400","500","600","700","800","900"];
    var fontstretchvalues = ["normal","ultra-condensed","extra-condensed","condensed","semi-condensed","semi-expanded","expanded","extra-expanded","ultra-expanded"];
    var fontstylevalues = ["normal","italic","oblique"];
    
    /* @import url() or */
    /* @font-face rule with font url()'s or */
    /* image url() or */
    /* avoid matches inside double-quote strings or */
    /* avoid matches inside single-quote strings or */
    /* avoid matches inside comments */
    
    regex = new RegExp(/(?:@import\s*(?:url\(\s*)?((?:"[^"]+")|(?:'[^']+')|(?:[^\s);]+))(?:\s*\))?\s*;)|/.source +  /* matches[1] */
                       /(?:@font-face\s*({[^}]*}))|/.source +  /* matches[2] */
                       /(?:url\(\s*((?:"[^"]+")|(?:'[^']+')|(?:[^\s)]+))\s*\))|/.source +  /* matches[3] */
                       /(?:"(?:\\"|[^"])*")|/.source +
                       /(?:'(?:\\'|[^'])*')|/.source +
                       /(?:\/\*(?:\*[^\/]|[^\*])*?\*\/)/.source,
                       "gi");
    
    while ((matches = regex.exec(csstext)) != null)  /* style sheet imported into style sheet */
    {
        if (matches[0].substr(0,7).toLowerCase() == "@import")  /* @import url() */
        {
            matches[1] = removeQuotes(matches[1]);
            
            if (replaceableResourceURL(matches[1]))
            {
                if (baseuri != null)
                {
                    location = resolveURL(matches[1],baseuri);
                    
                    if (location != null)
                    {
                        location = removeFragment(location);
                        
                        for (i = 0; i < resourceLocation.length; i++)
                            if (resourceLocation[i] == location && resourceStatus[i] == "success") break;
                        
                        if (i < resourceLocation.length)  /* style sheet found */
                        {
                            if (importstack.indexOf(location) < 0)
                            {
                                importstack.push(location);
                                
                                rememberCSSURLsInStyleSheet(resourceContent[i],resourceLocation[i],crossframe,loadedfonts,importstack,framekey);
                                
                                importstack.pop();
                            }
                        }
                    }
                }
            }
        }
        else if (matches[0].substr(0,10).toLowerCase() == "@font-face")  /* @font-face rule */
        {
            includeall = (savedItems == 2 && saveCSSFontsAll);
            includewoff = (savedItems == 1 || (savedItems == 2 && saveCSSFontsWoff));
            
            propmatches = matches[2].match(/font-family\s*:\s*((?:"[^"]+")|(?:'[^']+')|(?:[^\s;}]+(?: [^\s;}]+)*))/i);
            if (propmatches == null) fontfamily = ""; else fontfamily = removeQuotes(unescapeCSSValue(propmatches[1])).toLowerCase();
            
            propmatches = matches[2].match(/font-weight\s*:\s*([^\s;}]*)/i);
            if (propmatches == null) fontweight = "normal";
            else if (fontweightvalues.indexOf(propmatches[1].toLowerCase()) < 0) fontweight = "normal";
            else fontweight = propmatches[1].toLowerCase();
            
            propmatches = matches[2].match(/font-style\s*:\s*([^\s;}]*)/i);
            if (propmatches == null) fontstyle = "normal";
            else if (fontstylevalues.indexOf(propmatches[1].toLowerCase()) < 0) fontstyle = "normal";
            else fontstyle = propmatches[1].toLowerCase();
            
            propmatches = matches[2].match(/font-stretch\s*:\s*([^\s;}]*)/i);
            if (propmatches == null) fontstretch = "normal";
            else if (fontstretchvalues.indexOf(propmatches[1].toLowerCase()) < 0) fontstretch = "normal";
            else fontstretch = propmatches[1].toLowerCase();
            
            fontmatches = false;
            
            for (i = 0; i < loadedfonts.length; i++)
            {
                if (removeQuotes(loadedfonts[i].family).toLowerCase() == fontfamily && loadedfonts[i].weight == fontweight &&
                    loadedfonts[i].style == fontstyle && loadedfonts[i].stretch == fontstretch) fontmatches = true;  /* font matches this @font-face rule */
            }
            
            if (fontmatches)
            {
                usedfilefound = false;
                wofffilefound = false;
                
                srcregex = /src:([^;}]*)[;}]/gi;  /* @font-face src list */
                
                while ((srcmatches = srcregex.exec(matches[2])) != null)  /* src: list of font file URLs */
                {
                    urlregex = /url\(\s*((?:"[^"]+")|(?:'[^']+')|(?:[^\s)]+))\s*\)(?:\s+format\(([^)]*)\))?/gi;  /* font url() and optional font format() list */
                    
                    while ((urlmatches = urlregex.exec(srcmatches[1])) != null)  /* font file URL */
                    {
                        urlmatches[1] = removeQuotes(urlmatches[1]);  /* url */
                        
                        if (replaceableResourceURL(urlmatches[1]))
                        {
                            fontfiletype = "";
                            
                            if (typeof urlmatches[2] != "undefined")  /* font format() list */
                            {
                                urlmatches[2] = urlmatches[2].replace(/"/g,"'");
                                
                                if (urlmatches[2].indexOf("'woff2'") >= 0) fontfiletype = "woff2";  /* Firefox, Chrome & Opera */
                                else if (urlmatches[2].indexOf("'woff'") >= 0) fontfiletype = "woff";  /* all browsers */
                                else if (urlmatches[2].indexOf("'truetype'") >= 0) fontfiletype = "ttf";  /* all browsers */
                                else if (urlmatches[2].indexOf("'opentype'") >= 0) fontfiletype = "otf";  /* all browsers */
                            }
                            else
                            {
                                if (urlmatches[1].indexOf(".woff2") >= 0) fontfiletype = "woff2";  /* Firefox, Chrome & Opera */
                                else if (urlmatches[1].indexOf(".woff") >= 0 && urlmatches[1].indexOf(".woff2") < 0) fontfiletype = "woff";  /* all browsers */
                                else if (urlmatches[1].indexOf(".ttf") >= 0) fontfiletype = "ttf";  /* all browsers */
                                else if (urlmatches[1].indexOf(".otf") >= 0) fontfiletype = "otf";  /* all browsers */
                            }
                            
                            if (fontfiletype != "")
                            {
                                if (!usedfilefound)
                                {
                                    usedfilefound = true;  /* first font file supported by this browser - should be the one used by this browser */
                                    
                                    if (fontfiletype == "woff") wofffilefound = true;
                                    
                                    rememberURL(urlmatches[1],baseuri,"application/font-woff","",false);
                                }
                                else if (includewoff && fontfiletype == "woff")
                                {
                                    wofffilefound = true;  /* woff font file supported by all browsers */
                                    
                                    rememberURL(urlmatches[1],baseuri,"application/font-woff","",false);
                                }
                                else if (includeall)
                                {
                                    rememberURL(urlmatches[1],baseuri,"application/font-woff","",false);
                                }
                            }
                            
                            if (!includeall && (wofffilefound || (!includewoff && usedfilefound))) break;
                        }
                    }
                    
                    if (!includeall && (wofffilefound || (!includewoff && usedfilefound))) break;
                }
            }
        }
        else if (matches[0].substr(0,4).toLowerCase() == "url(")  /* image url() */
        {
            if ((savedItems == 2 && saveCSSImagesAll) || crossframe)
            {
                matches[3] = removeQuotes(matches[3]);
                
                if (replaceableResourceURL(matches[3]))
                {
                    rememberCSSImageURL(matches[3],baseuri,"image/png","",false,framekey);
                }
            }
        }
        else if (matches[0].substr(0,1) == "\"") ;  /* double-quote string */
        else if (matches[0].substr(0,1) == "'") ;  /* single-quote string */
        else if (matches[0].substr(0,2) == "/*") ;  /* comment */
    }
}

function rememberCSSImageURLs(csstext,baseuri,framekey)
{
    var regex;
    var matches = [];
    
    regex = /url\(\s*((?:"[^"]+")|(?:'[^']+')|(?:[^\s)]+))\s*\)/gi;  /* image url() */
    
    while ((matches = regex.exec(csstext)) != null)
    {
        matches[1] = removeQuotes(matches[1]);
        
        if (replaceableResourceURL(matches[1]))
        {
            rememberCSSImageURL(matches[1],baseuri,"image/png","",false,framekey);
        }
    }
}

function rememberCSSImageURL(url,baseuri,mimetype,charset,passive,framekey)
{
    var i,location;
    
    if (pageType > 0) return -1;  /* saved page - ignore new resources when re-saving */
    
    if (baseuri != null)
    {
        location = resolveURL(url,baseuri);
        
        if (location != null)
        {
            baseuri = removeFragment(baseuri);
            
            location = removeFragment(location);
            
            if (location == "" || location == baseuri) return -1;
            
            for (i = 0; i < resourceLocation.length; i++)
                if (resourceLocation[i] == location) break;
            
            if (i == resourceLocation.length)  /* new resource */
            {
                resourceLocation[i] = location;
                resourceReferrer[i] = baseuri;
                resourceMimeType[i] = mimetype;  /* default if load fails */
                resourceCharSet[i] = charset;  /* default if load fails */
                resourcePassive[i] = passive;
                resourceContent[i] = "";  /* default if load fails */
                resourceStatus[i] = "pending";
                resourceReason[i] = "";
                resourceRemembered[i] = 1;
                resourceReplaced[i] = 0;
                resourceCSSRemembered[i] = 1;
                resourceCSSFrameKeys[i] = {};
                resourceCSSFrameKeys[i][framekey] = true;
                
                return i;
            }
            else  /* repeated resource */
            {
                resourceRemembered[i]++;
                resourceCSSRemembered[i]++;
                resourceCSSFrameKeys[i][framekey] = true;
            }
        }
    }
    
    return -1;
}

function rememberURL(url,baseuri,mimetype,charset,passive)
{
    var i,location;
    
    if (pageType > 0) return -1;  /* saved page - ignore new resources when re-saving */
    
    if (baseuri != null)
    {
        location = resolveURL(url,baseuri);
        
        if (location != null)
        {
            baseuri = removeFragment(baseuri);
            
            location = removeFragment(location);
            
            if (location == "" || location == baseuri) return -1;
            
            for (i = 0; i < resourceLocation.length; i++)
                if (resourceLocation[i] == location) break;
            
            if (i == resourceLocation.length)  /* new resource */
            {
                resourceLocation[i] = location;
                resourceReferrer[i] = baseuri;
                resourceMimeType[i] = mimetype;  /* default if load fails */
                resourceCharSet[i] = charset;  /* default if load fails */
                resourcePassive[i] = passive;
                resourceContent[i] = "";  /* default if load fails */
                resourceStatus[i] = "pending";
                resourceReason[i] = "";
                resourceRemembered[i] = 1;
                resourceReplaced[i] = 0;
                resourceCSSRemembered[i] = 0;
                resourceCSSFrameKeys[i] = {};
                
                return i;
            }
            else  /* repeated resource */
            {
                resourceRemembered[i]++;
            }
        }
    }
    
    return -1;
}

function unescapeCSSValue(value)
{
    var regex,codepoint;
    
    regex = /\\(?:([0-9A-Fa-f]{1,6})|(.))/g;
    
    return value.replace(regex,_replaceEscapeSequences);
    
    function _replaceEscapeSequences(match,p1,p2,offset,string)
    {
        if (p2) return p2;  /* single-character escape sequence */
        
        codepoint = parseInt(p1,16);
        
        if (codepoint == 0x0000 || codepoint > 0x10FFFF) return "\uFFFD";  /* not Unicode code point */
        if (codepoint >= 0xD800 && codepoint <= 0xDFFF) return "\uFFFD";  /* surrogate code point */
        
        return String.fromCodePoint(codepoint);  /* codepoint escape sequence */
    }
}

/************************************************************************/

/* After first or second pass - load resources */

function loadResources()
{
    var i;
    
    timeStart[passNumber+3] = performance.now();
    
    resourceCount = 0;
    
    for (i = 0; i < resourceLocation.length; i++)
        if (resourceStatus[i] == "pending") resourceCount++;
    
    if (resourceCount <= 0)
    {
        timeFinish[passNumber+3] = performance.now();
        
        if (passNumber == 1) gatherOtherResources();
        else if (passNumber == 2) checkResources();
    }
    else
    {
        for (i = 0; i < resourceLocation.length; i++)
        {
            if (resourceStatus[i] == "pending") 
            {
                if (safeContentOrAllowedMixedContent(i))
                {
                     loadResource(i,resourceLocation[i],resourceReferrer[i],getReferrerPolicy());
                }
                else loadFailure(i,"mixed");
            }
        }
    }
}

async function loadResource(index,location,referrer,referrerPolicy)
{
    var controller,timeout,response;
    var contentType,mimetype,charset,body;
    var matches = [];
    
    resourceStatus[index] = "loading";
    
    controller = new AbortController();
    
    timeout = window.setTimeout(
    function()
    {
        controller.abort();
    },maxResourceTime*1000);
    
    try  /* load resource in content script */
    {
        response = await fetch(location,{ method: "GET", mode: "cors", cache: "no-cache", referrer: referrer, referrerPolicy: referrerPolicy, signal: controller.signal });
        
        if (debugEnable) console.log("Content Fetch - index: " + index + " - status: " + response.status + " - referrer: " + referrer + " - policy: " + referrerPolicy + " - location: " + location);
        
        if (response.status == 200)
        {
            contentType = response.headers.get("Content-Type");
            if (contentType == null) contentType = "";
            
            matches = contentType.match(/([^;]+)/i);
            if (matches != null) mimetype = matches[1].toLowerCase();
            else mimetype = "";
            
            matches = contentType.match(/;charset=([^;]+)/i);
            if (matches != null) charset = matches[1].toLowerCase();
            else charset = "";

            body = await globalThis.browserRecallBoundedResponse.readBoundedResponse(response,maxResourceSize*1024*1024);

            if (body.status == "maxsize")
            {
                loadFailure(index,"maxsize");
            }
            else
            {
                loadSuccess(index,"",body.content,mimetype,charset);
            }
        }
        else  /* load resource in background script */
        {
            if (resourceMimeType[index] == "application/font-woff")
            {
                /* Fonts must be loaded with CORS - but cannot be sure of CORS in background script */
                
                loadFailure(index,"corsfail");
            }
            else
            {
                /* Most likely resource for <link>/<script>/<img>/<audio>/<video> element with crossorigin attribute requiring background fetch */
                
                chrome.runtime.sendMessage({ type: "loadResource", captureId: captureId, index: index, location: location, referrer: referrer, referrerPolicy: referrerPolicy });
            }
        }
    }
    catch (e)
    {
        if (e.name == "AbortError")
        {
            loadFailure(index,"maxtime");
        }
        else  /* load resource in background script */
        {
            if (resourceMimeType[index] == "application/font-woff")
            {
                /* Fonts must be loaded with CORS - but cannot be sure of CORS in background script */
                
                loadFailure(index,"corsfail");
            }
            else
            {
                /* Most likely resource for <link>/<script>/<img>/<audio>/<video> element with crossorigin attribute requiring background fetch */
                
                chrome.runtime.sendMessage({ type: "loadResource", captureId: captureId, index: index, location: location, referrer: referrer, referrerPolicy: referrerPolicy });
            }
        }
    }
    finally
    {
        window.clearTimeout(timeout);
    }
}

function loadSuccess(index,reason,content,mimetype,charset)
{
    var i,resourceURL,frameURL,csstext,baseuri,regex,documentURL;
    var matches = [];

    /* Guard against undefined resource slot (e.g. CSP blocked base-uri injection) */

    if (!resourceMimeType[index])
    {
        loadFailure(index,"mime");
        return;
    }

    /* Process file based on expected MIME type */

    switch (resourceMimeType[index].toLowerCase())  /* expected MIME type */
    {
        case "application/font-woff":  /* font file */
            
            /* font file - fall through */
            
        case "image/svg+xml":  /* svg file or image file*/
        case "image/png":  /* image file */
        case "image/vnd.microsoft.icon":  /* icon file */
        case "audio/mpeg":  /* audio file */
        case "video/mp4":  /* video file */
        case "application/octet-stream":  /* data file */
            
            if (mimetype != "image/svg+xml")  /* not svg file */
            {
                if (mimetype != "") resourceMimeType[index] = mimetype;
                resourceCharSet[index] = "";
                
                resourceContent[index] = content;
                
                break;
            }
            
            /* svg file - fall through */
            
        case "text/javascript":  /* javascript file */
            
            if (mimetype != "image/svg+xml")  /* svg file */
            {
                /* See Mozilla source/dom/base/nsContentUtils.cpp for list of supported JavaScript MIME types */
                
                if (mimetype != "text/javascript" && mimetype != "text/ecmascript" &&
                    mimetype != "application/javascript" && mimetype != "application/ecmascript" && mimetype != "application/x-javascript" && mimetype != "application/x-ecmascript" &&
                    mimetype != "text/javascript1.0" && mimetype != "text/javascript1.1" && mimetype != "text/javascript1.2" && mimetype != "text/javascript1.3" &&
                    mimetype != "text/javascript1.4" && mimetype != "text/javascript1.5" &&
                    mimetype != "text/x-ecmascript"&& mimetype != "text/x-javascript")  /* incorrect MIME type */
                {
                    loadFailure(index,"mime");
                    
                    return;
                }
            }
            
            /* svg or javascript file - fall through */
            
        case "text/vtt":  /* subtitles file */
            
            if (mimetype != "") resourceMimeType[index] = mimetype;
            if (charset != "") resourceCharSet[index] = charset;
            
            if (content.charCodeAt(0) == 0xEF && content.charCodeAt(1) == 0xBB && content.charCodeAt(2) == 0xBF)  /* BOM */
            {
                resourceCharSet[index] = "utf-8";
                content = content.substr(3);
            }
            
            if (resourceCharSet[index].toLowerCase() == "utf-8")
            {
                try
                {
                    resourceContent[index] = convertUTF8ToUTF16(content);  /* UTF-8 */
                }
                catch (e)
                {
                    resourceCharSet[index] = "iso-8859-1";  /* assume ISO-8859-1 */
                    resourceContent[index] = content;
                }
            }
            else resourceContent[index] = content;  /* ASCII, ANSI, ISO-8859-1, etc */
            
            break;
            
        case "text/css":  /* css file */
            
            if (mimetype != "text/css")  /* incorrect MIME type */
            {
                loadFailure(index,"mime");
                
                return;
            }
            
            matches = content.match(/^@charset "([^"]+)";/i);
            if (matches != null) resourceCharSet[index] = matches[1];
            
            if (charset != "") resourceCharSet[index] = charset;
            
            if (content.charCodeAt(0) == 0xEF && content.charCodeAt(1) == 0xBB && content.charCodeAt(2) == 0xBF)  /* BOM */
            {
                resourceCharSet[index] = "utf-8";
                content = content.substr(3);
            }
            
            if (resourceCharSet[index].toLowerCase() == "utf-8")
            {
                try
                {
                    resourceContent[index] = convertUTF8ToUTF16(content);  /* UTF-8 */
                }
                catch (e)
                {
                    resourceCharSet[index] = "iso-8859-1";  /* assume ISO-8859-1 */
                    resourceContent[index] = content;
                }
            }
            else resourceContent[index] = content;  /* ASCII, ANSI, ISO-8859-1, etc */
            
            /* External style sheets imported in external style sheet */
            
            csstext = resourceContent[index];
            
            baseuri = resourceLocation[index];
            
            regex = /@import\s*(?:url\(\s*)?((?:"[^"]+")|(?:'[^']+')|(?:[^\s);]+))(?:\s*\))?\s*;/gi;  /* @import url() */
            
            while ((matches = regex.exec(csstext)) != null)  /* style sheet imported into style sheet */
            {
                matches[1] = removeQuotes(matches[1]);
                
                if (replaceableResourceURL(matches[1]))
                {
                    i = rememberURL(matches[1],baseuri,"text/css",resourceCharSet[index],false);
                    
                    if (i >= 0)  /* new style sheet */
                    {
                        resourceCount++;
                        
                        if (safeContentOrAllowedMixedContent(i))
                        { 
                            loadResource(i,resourceLocation[i],resourceReferrer[i],getReferrerPolicy());
                        }
                        else loadFailure(i,"mixed");
                    }
                }
            }
            
            break;
    }
    
    resourceStatus[index] = "success";
    
    resourceReason[index] = reason;
    
    if (--resourceCount <= 0)
    {
        timeFinish[passNumber+3] = performance.now();
        
        if (passNumber == 1) gatherOtherResources();
        else if (passNumber == 2) checkResources(); 
    }
}

function loadFailure(index,reason)
{
    var normalizedReason;

    normalizedReason = String(reason).replace(/\*$/,"");
    if (normalizedReason == "maxtime" || normalizedReason == "maxsize" || normalizedReason == "fetcherr" || normalizedReason.substr(0,5) == "load:")
    {
        chrome.runtime.sendMessage({ type: "resourceFailure", captureId: captureId, location: resourceLocation[index], reason: normalizedReason });
    }

    resourceStatus[index] = "failure";
    
    resourceReason[index] = reason;
    
    if (--resourceCount <= 0)
    {
        timeFinish[passNumber+3] = performance.now();
        
        if (passNumber == 1) gatherOtherResources();
        else if (passNumber == 2) checkResources();
    }
}

function safeContentOrAllowedMixedContent(index)
{
    var documentURL,pagescheme,safeContent,mixedContent;
    
    /* Load request must not be sent if http: resource in https: page or https: referrer */
    /* unless passive mixed content and allowed by user option */
    
    documentURL = new URL(document.baseURI);
    
    pagescheme = documentURL.protocol;
    
    safeContent = (resourceLocation[index].substr(0,6) == "https:" || (resourceLocation[index].substr(0,5) == "http:" && resourceReferrer[index].substr(0,5) == "http:" && pagescheme == "http:"));
    
    mixedContent = (resourceLocation[index].substr(0,5) == "http:" && (resourceReferrer[index].substr(0,6) == "https:" || pagescheme == "https:"));
    
    if (safeContent || (mixedContent && resourcePassive[index] && allowPassive)) return true;
    
    return false;
}

function getReferrerPolicy()
{
    var  incognito;
    
    incognito = chrome.extension.inIncognitoContext;
    
    if (crossOrigin == 0 || incognito) return "strict-origin-when-cross-origin";
    
    return "no-referrer-when-downgrade";
}

function convertUTF8ToUTF16(utf8str)
{
    var i,byte1,byte2,byte3,byte4,codepoint,utf16str;
    
    /* Convert UTF-8 string to Javascript UTF-16 string */
    /* Each codepoint in UTF-8 string comprises one to four 8-bit values */
    /* Each codepoint in UTF-16 string comprises one or two 16-bit values */
    
    i = 0;
    utf16str = "";
    
    while (i < utf8str.length)
    {
        byte1 = utf8str.charCodeAt(i++);
        
        if ((byte1 & 0x80) == 0x00)
        {
            utf16str += String.fromCharCode(byte1);  /* one 16-bit value */
        }
        else if ((byte1 & 0xE0) == 0xC0)
        {
            byte2 = utf8str.charCodeAt(i++);
            
            codepoint = ((byte1 & 0x1F) << 6) + (byte2 & 0x3F);
            
            utf16str += String.fromCodePoint(codepoint);  /* one 16-bit value */
        }
        else if ((byte1 & 0xF0) == 0xE0)
        {
            byte2 = utf8str.charCodeAt(i++);
            byte3 = utf8str.charCodeAt(i++);
            
            codepoint = ((byte1 & 0x0F) << 12) + ((byte2 & 0x3F) << 6) + (byte3 & 0x3F);
            
            utf16str += String.fromCodePoint(codepoint);  /* one 16-bit value */
        }
        else if ((byte1 & 0xF8) == 0xF0)
        {
            byte2 = utf8str.charCodeAt(i++);
            byte3 = utf8str.charCodeAt(i++);
            byte4 = utf8str.charCodeAt(i++);
            
            codepoint = ((byte1 & 0x07) << 18) + ((byte2 & 0x3F) << 12) + ((byte3 & 0x3F) << 6) + (byte4 & 0x3F);
            
            utf16str += String.fromCodePoint(codepoint);  /* two 16-bit values */
        }
    }
    
    return utf16str;
}

/************************************************************************/

/* After second pass - check resources (Browser Recall: skip warnings, go straight to generate) */

function checkResources()
{
    generateHTML();
}

/************************************************************************/

/* enterComments — stripped (Browser Recall: no UI panels) */

function enterComments()
{
    generateHTML();
}

/************************************************************************/

/* Third Pass - to generate HTML and save to file */

function generateHTML()
{
    var i;

    passNumber = 3;

    saveState = 3;  /* third pass */

    chrome.runtime.sendMessage({ type: "stateChanged", pagetype: pageType, savestate: saveState });

    /* Generate HTML */

    timeStart[3] = performance.now();

    extractHTML(0,window,document.documentElement,false,false,"0",0,0);

    timeFinish[3] = performance.now();

    /* Release resources */

    frameKey.length = 0;
    frameURL.length = 0;
    frameHTML.length = 0;
    frameFonts.length = 0;

    resourceLocation.length = 0;
    resourceReferrer.length = 0;
    resourceMimeType.length = 0;
    resourceCharSet.length = 0;
    resourcePassive.length = 0;
    resourceContent.length = 0;
    resourceStatus.length = 0;
    resourceReason.length = 0;
    resourceRemembered.length = 0;
    resourceReplaced.length = 0;
    resourceCSSRemembered.length = 0;
    resourceCSSFrameKeys.length = 0;

    firstIconLocation = "";
    rootIconLocation = "";

    enteredComments = "";

    if (cancelSave)
    {
        htmlStrings.length = 0;

        saveState = -1;

        chrome.runtime.sendMessage({ type: "saveExit", captureId: captureId, pagetype: pageType, savestate: saveState });
    }
    else
    {
        /* Browser Recall: send HTML back to background via message instead of downloading */

        var html = htmlStrings.join("");

        htmlStrings.length = 0;

        saveState = 6;

        chrome.runtime.sendMessage({ type: "savepageDone", captureId: captureId, html: html });
    }
}

function undoShrinkPage()
{
    document.documentElement.style.cssText = htmlCssText;
    document.body.style.cssText = bodyCssText;

    window.scrollTo(0,origScrollY);
}

function extractHTML(depth,frame,element,crossframe,nosrcframe,framekey,parentpreserve,indent)
{
    var i,j,tagName,startTag,textContent,endTag,inline,preserve,style,display,position,whitespace,displayed,csstext,baseuri,documenturi,separator,origurl,datauri,origstr,dupelement,dupsheet,location,newurl;
    var visible,width,height,currentsrc,svgstr,parser,svgdoc,svgfragid,svgelement,svghref,subframekey,startindex,endindex,htmltext,origsrcdoc,origsandbox,framedoc,prefix,shadowroot;
    var doctype,target,text,asciistring,date,datestr,pubelement,pubstr,pubzone,pubdate,pubdatestr,pageurl,state;
    var pubmatches = [];
    var metadataElements = ["base","link","meta","noscript","script","style","template","title"];  /* HTML Living Standard 3.2.5.2.1 Metadata Content */
    var voidElements = ["area","base","br","col","command","embed","frame","hr","img","input","keygen","link","menuitem","meta","param","source","track","wbr"];  /* W3C HTML5 2011 4.3 Elements + menuitem */
    var retainElements = ["html","head","body","base","command","link","meta","noscript","script","style","template","title"];
    var hiddenElements = ["area","base","datalist","head","link","meta","param","rp","script","source","style","template","track","title"];  /* W3C HTML5 2014 10.3.1 Hidden Elements */
    
    /* Check for <button> element inside ancestor <button> element - W3C HTML5 2011 4.10.8 The button Element (no interactive content) */
    
    if (element.localName == "button" && element.parentElement != null && element.parentElement.closest("button") != null) tagName = "span";
    else tagName = element.localName;
    
    /* Create element start and end tags */
    
    startTag = "<" + tagName;
    for (i = 0; i < element.attributes.length; i++)
    {
        if (element.attributes[i].name != "zoompage-fontsize")
        {
            startTag += " " + element.attributes[i].name;
            startTag += "=\"";
            startTag += element.attributes[i].value.replace(/"/g,"&quot;");
            startTag += "\"";
        }
    }
    if (element.parentElement != null && element.parentElement.localName == "head" && metadataElements.indexOf(tagName) < 0)
    {
        /* Non-metadata element in head will be moved to body when saved page is opened */
        /* Add hidden attribute to keep element hidden */
        
        startTag += " data-savepage-nonmetadata=\"\" hidden=\"\"";
    }
    startTag += ">";
    
    textContent = "";
    
    if (voidElements.indexOf(tagName) >= 0) endTag = "";
    else endTag = "</" + tagName + ">";
    
    /* Determine if element is phrasing content - set inline based on CSS display value */
    
    /* Determine if element format should be preserved - set preserve based on CSS white-space value */
    /*   0 = collapse newlines, collapse spaces (normal or nowrap) */
    /*   1 = preserve newlines, collapse spaces (pre-line)         */
    /*   2 = preserve newlines, preserve spaces (pre or pre-wrap)  */
    
    if (pageType == 0 && formatHTML && depth == 0)
    {
        if (crossframe)
        {
            /* In a cross-origin frame, the document created by DOMParser */
            /* does not have an associated frame window, which means that */
            /* the window.getComputedStyle() function cannot be called.   */
            
            /* Assume all elements are block with collapsed newlines and spaces */
            
            inline = false;
            preserve = 0;
        }
        else if ((style = frame.getComputedStyle(element)) == null)  /* should not happen */
        {
            inline = false;
            preserve = 0;
        }
        else
        {
            display = style.getPropertyValue("display");
            position = style.getPropertyValue("position");
            whitespace = style.getPropertyValue("white-space");
            
            if (display.indexOf("inline") >= 0 || (display == "none" && document.body.contains(element))) inline = true;
            else if (position == "absolute" || position == "fixed") inline = true;
            else inline = false;
            
            if (whitespace == "pre" || whitespace == "pre-wrap") preserve = 2;
            else if (whitespace == "pre-line") preserve = 1;
            else /* normal or nowrap */ preserve = 0;
        }
    }
    else
    {
        inline = false;
        preserve = 0;
    }
    
    /* Determine if element is displayed */
    
    if (crossframe)
    {
        /* In a cross-origin frame, the document created by DOMParser */
        /* does not have an associated frame window, which means that */
        /* the window.getComputedStyle() function cannot be called.   */
        
        /* Assume all elements are displayed */
        
        displayed = true;
    }
    else if ((style = frame.getComputedStyle(element)) == null) displayed = true;  /* should not happen */
    else displayed = (style.getPropertyValue("display") != "none");  /* element not collapsed */
    
    /* Extract HTML from DOM and replace external resources with data URI's */
    
    /* External images referenced in any element's style attribute */
    
    if (element.hasAttribute("style"))
    {
        csstext = element.getAttribute("style");
        
        baseuri = element.ownerDocument.baseURI;
        
        documenturi = element.ownerDocument.documentURI;
        
        csstext = replaceCSSImageURLs(csstext,baseuri,documenturi,framekey);
        
        startTag = startTag.replace(/ style="(?:\\"|[^"])*"/," style=\"" + csstext.replace(/"/g,"&quot;") + "\"");
    }
    
    /* Remove or Rehide elements */
    
    if (removeElements)
    {
        /* Remove elements that have been collapsed by the page, page editors or content blockers - so are not displayed */
        /* Do not remove elements that are essential */
        /* Do not remove <svg> elements because child elements may be referenced by <use> elements in other <svg> elements */
    
        if (retainElements.indexOf(element.localName) < 0 && !(element instanceof SVGElement) && !displayed)
        {
            htmlStrings[htmlStrings.length] = "<!--savepage-" + element.localName + "-remove-->";
            
            return;
        }
    }
    else if (rehideElements)
    {
        /* Rehide elements that have been collapsed by the page, page editors or content blockers - so are not displayed */
        /* Do not hide elements that are hidden by default */
        
        if (hiddenElements.indexOf(element.localName) < 0 && !displayed)
        {
            csstext = "/*savepage-rehide*/ display: none !important;";
            
            if (element.hasAttribute("style"))
            {
                if (element.getAttribute("style").trim().substr(-1) != ";") separator = "; ";
                else separator = " ";
                
                startTag = startTag.replace(/ style="(?:\\"|[^"])*"/," style=\"" + element.getAttribute("style").replace(/"/g,"&quot;") + separator + csstext + "\"");
            }
            else startTag = startTag.replace("<" + element.localName,"<" + element.localName + " style=\"" + csstext + "\"");
        }
    }
    
    /* Content Security Policy in <meta> element */
    
    if (element.localName == "meta")
    {
        if (element.httpEquiv.toLowerCase() == "content-security-policy")
        {
            origstr = " data-savepage-content=\"" + element.content + "\"";
            
            startTag = startTag.replace(/ content="(?:\\"|[^"])*"/,origstr + " content=\"\"");
        }
    }
    
    /* External script referenced in <script> element */
    /* Internal script in <script> element */
    
    else if (element.localName == "script")
    {
        if ((savedItems == 2 && saveScripts) && !crossframe && !nosrcframe)
        {
            if (element.getAttribute("src"))  /* external script */
            {
                if (replaceableResourceURL(element.src))
                {
                    baseuri = element.ownerDocument.baseURI;
                    
                    documenturi = element.ownerDocument.documentURI;
                    
                    origurl = element.getAttribute("src");
                    
                    datauri = replaceURL(origurl,baseuri,documenturi);
                    
                    origstr = (datauri == origurl) ? "" : " data-savepage-src=\"" + origurl + "\"";
                    
                    startTag = startTag.replace(/ src="[^"]*"/,origstr + " src=\"" + datauri + "\"");
                }
            }
            else  /* internal script */
            {
                textContent = element.textContent;
            }
            
            if (!executeScripts)
            {
                if (element.hasAttribute("type")) origstr = " data-savepage-type=\"" + element.getAttribute("type") + "\"";
                else origstr = " data-savepage-type=\"\"";
                
                if (element.hasAttribute("type")) startTag = startTag.replace(/ type="[^"]*"/,origstr + " type=\"text/plain\"");
                else startTag = startTag.replace(/<script/,"<script" + origstr + " type=\"text/plain\"");
            }
        }
        else
        {
            if (element.getAttribute("src"))  /* external script */
            {
                origurl = element.getAttribute("src");
                
                origstr = " data-savepage-src=\"" + origurl + "\"";
                
                startTag = startTag.replace(/ src="[^"]*"/,origstr + "");  /* replacing with src="" would be invalid HTML */
            }
            
            if (element.hasAttribute("type")) origstr = " data-savepage-type=\"" + element.getAttribute("type") + "\"";
            else origstr = " data-savepage-type=\"\"";
            
            if (element.hasAttribute("type")) startTag = startTag.replace(/ type="[^"]*"/,origstr + " type=\"text/plain\"");
            else startTag = startTag.replace(/<script/,"<script" + origstr + " type=\"text/plain\"");
        }
    }
    
    /* External images or fonts referenced in <style> element */
    
    else if (element.localName == "style")
    {
        if (element.id == "zoompage-pageload-style" || element.id == "zoompage-zoomlevel-style" || element.id == "zoompage-fontsize-style")  /* Zoom Page WE */
        {
            startTag = "";
            endTag = "";
            textContent = "";
        }
        else if (element.hasAttribute("class") && element.getAttribute("class").indexOf("darkreader") >= 0)  /* Dark Reader*/
        {
            startTag = "";
            endTag = "";
            textContent = "";
        }
        else
        {
            if (!element.disabled)
            {
                if (element.hasAttribute("data-savepage-sheetrules"))
                {
                    csstext = element.getAttribute("data-savepage-sheetrules");
                    
                    startTag = startTag.replace(/ data-savepage-sheetrules="(?:\\"|[^"])*"/," data-savepage-sheetrules=\"\"");
                }
                else
                {
                    try
                    {
                        /* Count rules in element.textContent by creating duplicate element */
                        
                        dupelement = element.ownerDocument.createElement("style");
                        dupelement.textContent = element.textContent;
                        element.ownerDocument.body.appendChild(dupelement);
                        dupsheet = dupelement.sheet;
                        dupelement.remove();
                        
                        /* There may be rules in element.sheet.cssRules that are not in element.textContent */
                        /* For example if the page uses CSS-in-JS Libraries */
                        
                        if (dupsheet.cssRules.length != element.sheet.cssRules.length)
                        {
                            csstext = "";
                            
                            for (i = 0; i < element.sheet.cssRules.length; i++)
                                csstext += element.sheet.cssRules[i].cssText + "\n";
                            
                            startTag = startTag.replace(/<style/,"<style data-savepage-sheetrules=\"\"");
                        }
                        else csstext = element.textContent;
                    }
                    catch (e)  /* sheet.cssRules does not exist or cross-origin style sheet */
                    {
                        csstext = element.textContent;
                    }
                }
                
                baseuri = element.ownerDocument.baseURI;
                
                documenturi = element.ownerDocument.documentURI;
                
                textContent = replaceCSSURLsInStyleSheet(csstext,baseuri,documenturi,[],framekey);
                
                if (swapDevices) textContent = swapScreenAndPrintDevices(textContent);
            }
            else
            {
                startTag = startTag.replace(/<style/,"<style data-savepage-disabled=\"\"");
                
                textContent = "";
            }
        }
    }
    
    /* External images or fonts referenced in <link> element */
    /* External icon referenced in <link> element */
    
    else if (element.localName == "link" && !(element.parentElement instanceof SVGElement))  /* <link> is invalid inside <svg> */
    {
        if (element.rel.toLowerCase().indexOf("stylesheet") >= 0 && element.getAttribute("href"))
        {
            if (!element.disabled)
            {
                if (replaceableResourceURL(element.href))
                {
                    baseuri = element.ownerDocument.baseURI;
                    
                    if (baseuri != null)
                    {
                        location = resolveURL(element.href,baseuri);
                        
                        if (location != null)
                        {
                            location = removeFragment(location);
                            
                            for (i = 0; i < resourceLocation.length; i++)
                                if (resourceLocation[i] == location && resourceStatus[i] == "success") break;
                            
                            if (i < resourceLocation.length)  /* style sheet found */
                            {
                                csstext = resourceContent[i];
                                
                                /* Converting <link> into <style> means that CSS rules are embedded in saved HTML file */
                                /* Therefore need to escape any </style> end tags that may appear inside CSS strings */
                                
                                csstext = csstext.replace(/<\/style>/gi,"<\\/style>");
                                
                                baseuri = element.href;
                                
                                documenturi = element.href;
                                
                                textContent = replaceCSSURLsInStyleSheet(csstext,baseuri,documenturi,[location],framekey);
                                
                                if (swapDevices) textContent = swapScreenAndPrintDevices(textContent);
                                
                                startTag = "<style data-savepage-href=\"" + element.getAttribute("href") + "\"";
                                if (element.type != "") startTag += " type=\"" + element.type + "\"";
                                if (element.media != "") startTag += " media=\"" + element.media + "\"";
                                startTag += ">";
                                endTag = "</style>";
                                
                                resourceReplaced[i]++;
                            }
                        }
                    }
                }
            }
            else
            {
                origurl = element.getAttribute("href");
                
                origstr = " data-savepage-href=\"" + origurl + "\"";
                
                startTag = startTag.replace(/<link/,"<link data-savepage-disabled=\"\"");
                startTag = startTag.replace(/ href="[^"]*"/,origstr + " href=\"\"");
            }
        }
        else if ((element.rel.toLowerCase() == "icon" || element.rel.toLowerCase() == "shortcut icon") && element.getAttribute("href"))
        {
            if (replaceableResourceURL(element.href))
            {
                baseuri = element.ownerDocument.baseURI;
                
                documenturi = element.ownerDocument.documentURI;
                
                origurl = element.getAttribute("href");
                
                datauri = replaceURL(origurl,baseuri,documenturi);
                
                origstr = (datauri == origurl) ? "" : " data-savepage-href=\"" + origurl + "\"";
                
                startTag = startTag.replace(/ href="[^"]*"/,origstr + " href=\"" + datauri + "\"");
            }
        }
        else if (element.rel.toLowerCase().indexOf("dns-prefetch") >= 0 || element.rel.toLowerCase().indexOf("preconnect") >= 0 ||
                 element.rel.toLowerCase().indexOf("prefetch") >= 0 || element.rel.toLowerCase().indexOf("preload") >= 0 ||
                 element.rel.toLowerCase().indexOf("prerender") >= 0)
        {
            origurl = element.getAttribute("href");
            
            origstr = " data-savepage-href=\"" + origurl + "\"";
            
            startTag = startTag.replace(/ href="[^"]*"/,origstr + " href=\"\"");
        }
        else  /* unsaved url */
        {
            baseuri = element.ownerDocument.baseURI;
            
            documenturi = element.ownerDocument.documentURI;
            
            origurl = element.getAttribute("href");
            
            newurl = unsavedURL(origurl,baseuri,documenturi);
            
            origstr = (newurl == origurl) ? "" : " data-savepage-href=\"" + origurl + "\"";
            
            startTag = startTag.replace(/ href="[^"]*"/,origstr + " href=\"" + newurl + "\"");
        }
    }
    else if (element.localName == "link" && (element.parentElement instanceof SVGElement))
    {
        /* Workaround for <link> element inside <svg> fragment which is invalid */
        
        startTag = "";
        endTag = "";
    }
    
    /* External location referenced in <a> or <area> element */
    /* Internal location referenced in <a> or <area> element */
    
    else if ((element.localName == "a" && element instanceof HTMLElement) || element.localName == "area")
    {
        if (element.getAttribute("href"))
        {
            baseuri = element.ownerDocument.baseURI;
            
            documenturi = element.ownerDocument.documentURI;
            
            origurl = element.getAttribute("href");
            
            newurl = adjustURL(origurl,baseuri,documenturi);
            
            if (newurl != origurl)
            {
                origstr = " data-savepage-href=\"" + origurl + "\"";
                
                startTag = startTag.replace(/ href="[^"]*"/,origstr + " href=\"" + newurl + "\"");
            }
        }
    }
    
    /* External image referenced in <body> element */
    
    else if (element.localName == "body")
    {
        if (element.getAttribute("background"))
        {
            if (replaceableResourceURL(element.background))
            {
                baseuri = element.ownerDocument.baseURI;
                
                documenturi = element.ownerDocument.documentURI;
                
                origurl = element.getAttribute("background");
                
                datauri = replaceURL(origurl,baseuri,documenturi);
                
                origstr = (datauri == origurl) ? "" : " data-savepage-background=\"" + origurl + "\"";
                
                startTag = startTag.replace(/ background="[^"]*"/,origstr + " background=\"" + datauri + "\"");
            }
        }
    }
    
    /* External image referenced in <img> element - can be inside <picture> element */
    
    else if (element.localName == "img")
    {
        /* Remove src/srcset of images that have been hidden by the page, page editors or content blockers - so are not visible */
        
        if (removeElements)
        {
            if (crossframe)
            {
                /* In a cross-origin frame, the document created by DOMParser */
                /* does not have an associated frame window, which means that */
                /* the window.getComputedStyle() function cannot be called.   */
                
                /* Assume all images are visible */
                
                visible = true;
            }
            else if ((style = frame.getComputedStyle(element)) == null) visible = true;  /* should not happen */
            else visible = (style.getPropertyValue("visibility") != "hidden" && style.getPropertyValue("opacity") != "0");  /* element hidden */
        }
        else visible = true;
        
        if (!visible)
        {
            width = style.getPropertyValue("width");
            height = style.getPropertyValue("height");
            
            csstext = "/*savepage-remove*/ width: " + width + " !important; height: " + height + " !important;";
            
            if (element.hasAttribute("style"))
            {
                if (element.getAttribute("style").trim().substr(-1) != ";") separator = "; ";
                else separator = " ";
                
                startTag = startTag.replace(/ style="(?:\\"|[^"])*"/," style=\"" + element.getAttribute("style").replace(/"/g,"&quot;") + separator + csstext + "\"");
            }
            else startTag = startTag.replace(/<img/,"<img style=\"" + csstext + "\"");
            
            startTag = startTag.replace(/ src="[^"]*"/,"");
            
            startTag = startTag.replace(/ srcset="[^"]*"/,"");
        }
        else
        {
            /* currentSrc is set from src or srcset attributes on this <img> element */
            /* or from srcset attribute on <source> element inside <picture> element */
            
            /* Firefox - workaround because element.currentSrc may be empty string in cross-origin frames */
            
            currentsrc = (element.currentSrc != "") ? element.currentSrc : (element.getAttribute("src") ? element.src : "");
            
            /* Chrome - workaround because element.currentSrc may have wrong fragment identifier for SVG images */
            
            currentsrc = (element.currentSrc.indexOf("#") < 0) ? element.currentSrc : (element.getAttribute("src") ? element.src : "");
            
            if (currentsrc != "")  /* currentSrc set from src or srcset attribute */
            {
                if (replaceableResourceURL(currentsrc))
                {
                    baseuri = element.ownerDocument.baseURI;
                    
                    documenturi = element.ownerDocument.documentURI;
                    
                    origurl = element.getAttribute("src");
                    
                    datauri = replaceURL(currentsrc,baseuri,documenturi);
                    
                    origstr = (currentsrc == origurl) ? "" : " data-savepage-currentsrc=\"" + currentsrc + "\"";
                    origstr += " data-savepage-src=\"" + origurl + "\"";
                    
                    if (element.hasAttribute("src")) startTag = startTag.replace(/ src="[^"]*"/,origstr + " src=\"" + datauri + "\"");
                    else startTag = startTag.replace(/<img/,"<img" + origstr + " src=\"" + datauri + "\"");
                }
                else if (currentsrc.substr(0,5).toLowerCase() == "data:")  /* data uri */
                {
                    origurl = element.getAttribute("src");
                    
                    datauri = currentsrc;
                    
                    origstr = (datauri == origurl) ? " " : " data-savepage-src=\"" + origurl + "\"";
                    
                    if (element.hasAttribute("src")) startTag = startTag.replace(/ src="[^"]*"/,origstr + " src=\"" + datauri + "\"");
                    else startTag = startTag.replace(/<img/,"<img" + origstr + " src=\"" + datauri + "\"");
                }
                else if (element.hasAttribute("data-savepage-blobdatauri") || currentsrc.substr(0,5) == "blob:")  /* blob url */
                {
                    baseuri = element.ownerDocument.baseURI;
                    
                    documenturi = element.ownerDocument.documentURI;
                    
                    origurl = element.getAttribute("src");
                    
                    if (element.hasAttribute("data-savepage-blobdatauri")) datauri = element.getAttribute("data-savepage-blobdatauri");
                    else datauri = createCanvasDataURL(currentsrc,baseuri,documenturi,element);
                    
                    origstr = (currentsrc == origurl) ? "" : " data-savepage-currentsrc=\"" + currentsrc + "\"";
                    origstr += " data-savepage-src=\"" + origurl + "\"";
                    
                    if (element.hasAttribute("src")) startTag = startTag.replace(/ src="[^"]*"/,origstr + " src=\"" + datauri + "\"");
                    else startTag = startTag.replace(/<img/,"<img" + origstr + " src=\"" + datauri + "\"");
                    
                    startTag = startTag.replace(/ data-savepage-blobdatauri="[^"]*"/,"");
                }
            }
            
            if (element.getAttribute("srcset"))
            {
                /* Remove srcset URLs - currentSrc may be set to one of these URLs - other URls are unsaved */
                
                origurl = element.getAttribute("srcset");
                
                origstr = " data-savepage-srcset=\"" + origurl + "\"";
                
                startTag = startTag.replace(/ srcset="[^"]*"/,origstr + " srcset=\"\"");
            }
        }
    }
    
    /* External image referenced in <input> element */
    /* Reinstate checked state or text value of <input> element */
    
    else if (element.localName == "input")
    {
        if (element.type.toLowerCase() == "image" && element.getAttribute("src"))
        {
            if (replaceableResourceURL(element.src))
            {
                baseuri = element.ownerDocument.baseURI;
                
                documenturi = element.ownerDocument.documentURI;
                
                origurl = element.getAttribute("src");
                
                datauri = replaceURL(origurl,baseuri,documenturi);
                
                origstr = (datauri == origurl) ? "" : " data-savepage-src=\"" + origurl + "\"";
                
                startTag = startTag.replace(/ src="[^"]*"/,origstr + " src=\"" + datauri + "\"");
            }
        }
        
        if (element.type.toLowerCase() == "file" || element.type.toLowerCase() == "password")
        {
            /* maintain security */
            
            if (element.hasAttribute("value")) startTag = startTag.replace(/ value="[^"]*"/," value=\"\"");
            else startTag = startTag.replace(/>$/," value=\"\">");
        }
        else if (element.type.toLowerCase() == "checkbox" || element.type.toLowerCase() == "radio")
        {
            if (!element.checked) startTag = startTag.replace(/ checked="[^"]*"/,"");
            else if (!element.hasAttribute("checked")) startTag = startTag.replace(/>$/," checked=\"\">");
        }
        else
        {
            if (element.hasAttribute("value")) startTag = startTag.replace(/ value="[^"]*"/," value=\"" + element.value + "\"");
            else startTag = startTag.replace(/>$/," value=\"" + element.value + "\">");
        }
    }
    
    /* Reinstate text value of <textarea> element */
    
    else if (element.localName == "textarea")
    {
        textContent = element.value;
    }
    
    /* Reinstate selected state of <option> element */
    
    else if (element.localName == "option")
    {
        if (element.selected) startTag = startTag.replace(/ selected="[^"]*"/," selected=\"\"");
        else startTag = startTag.replace(/ selected="[^"]*"/,"");
    }
    
    /* Graphics drawn within <canvas> element */
    
    else if (element.localName == "canvas")
    {
        csstext = "background-attachment: scroll !important; " + "background-blend-mode: normal !important; " +
                  "background-clip: content-box !important; " + "background-color: transparent !important; " +
                  "background-origin: content-box !important; " + "background-position: center center !important; " +
                  "background-repeat: no-repeat !important; " + "background-size: 100% 100% !important;";
                  
        if (element.hasAttribute("data-savepage-canvasdatauri"))  /* canvas data url */
        {
            datauri = element.getAttribute("data-savepage-canvasdatauri");
            
            csstext = "/*savepage-canvas-image*/ " + "background-image: url(" + datauri + ") !important; " + csstext;
        }
        else
        {
            try
            {
                datauri = element.toDataURL("image/png","");
                
                csstext = "/*savepage-canvas-image*/ " + "background-image: url(" + datauri + ") !important; " + csstext;
            }
            catch (e) { csstext = "/*savepage-canvas-dirty*/"; }
        }
        
        if (element.hasAttribute("style"))
        {
            if (element.getAttribute("style").trim().substr(-1) != ";") separator = "; ";
            else separator = " ";
            
            startTag = startTag.replace(/ style="(?:\\"|[^"])*"/," style=\"" + element.getAttribute("style").replace(/"/g,"&quot;") + separator + csstext + "\"");
        }
        else startTag = startTag.replace(/<canvas/,"<canvas style=\"" + csstext + "\"");
    }
    
    /* External audio referenced in <audio> element */
    
    else if (element.localName == "audio")
    {
        if (element.getAttribute("src"))
        {
            if (element.src == element.currentSrc)
            {
                if (replaceableResourceURL(element.src))
                {
                    baseuri = element.ownerDocument.baseURI;
                    
                    documenturi = element.ownerDocument.documentURI;
                    
                    origurl = element.getAttribute("src");
                    
                    datauri = replaceURL(origurl,baseuri,documenturi);
                    
                    origstr = (datauri == origurl) ? "" : " data-savepage-src=\"" + origurl + "\"";
                    
                    startTag = startTag.replace(/ src="[^"]*"/,origstr + " src=\"" + datauri + "\"");
                }
            }
            else  /* unsaved url */
            {
                baseuri = element.ownerDocument.baseURI;
                
                documenturi = element.ownerDocument.documentURI;
                
                origurl = element.getAttribute("src");
                
                newurl = unsavedURL(origurl,baseuri,documenturi);
                
                origstr = (newurl == origurl) ? "" : " data-savepage-src=\"" + origurl + "\"";
                
                startTag = startTag.replace(/ src="[^"]*"/,origstr + " src=\"" + newurl + "\"");
            }
        }
    }
    
    /* External video referenced in <video> element */
    
    else if (element.localName == "video")
    {
        if (element.getAttribute("src"))
        {
            if (element.src == element.currentSrc)
            {
                if (replaceableResourceURL(element.src))
                {
                    baseuri = element.ownerDocument.baseURI;
                    
                    documenturi = element.ownerDocument.documentURI;
                    
                    origurl = element.getAttribute("src");
                    
                    datauri = replaceURL(origurl,baseuri,documenturi);
                    
                    origstr = (datauri == origurl) ? "" : " data-savepage-src=\"" + origurl + "\"";
                    
                    startTag = startTag.replace(/ src="[^"]*"/,origstr + " src=\"" + datauri + "\"");
                }
            }
            else  /* unsaved url */
            {
                baseuri = element.ownerDocument.baseURI;
                
                documenturi = element.ownerDocument.documentURI;
                
                origurl = element.getAttribute("src");
                
                newurl = unsavedURL(origurl,baseuri,documenturi);
                
                origstr = (newurl == origurl) ? "" : " data-savepage-src=\"" + origurl + "\"";
                
                startTag = startTag.replace(/ src="[^"]*"/,origstr + " src=\"" + newurl + "\"");
            }
        }
        
        if (element.getAttribute("poster"))
        {
            if (replaceableResourceURL(element.poster))
            {
                baseuri = element.ownerDocument.baseURI;
                
                documenturi = element.ownerDocument.documentURI;
               
                origurl = element.getAttribute("poster");
                
                datauri = replaceURL(origurl,baseuri,documenturi);
                
                origstr = (datauri == origurl) ? "" : " data-savepage-poster=\"" + origurl + "\"";
                
                startTag = startTag.replace(/ poster="[^"]*"/,origstr + " poster=\"" + datauri + "\"");
            }
        }
        else if (element.hasAttribute("data-savepage-blobdatauri") || element.src.substr(0,5) == "blob:")
        {
            baseuri = element.ownerDocument.baseURI;
            
            documenturi = element.ownerDocument.documentURI;
            
            origurl = element.getAttribute("src");
            
            if (element.hasAttribute("data-savepage-blobdatauri")) datauri = element.getAttribute("data-savepage-blobdatauri");
            else datauri = createCanvasDataURL(origurl,baseuri,documenturi,element);
            
            origstr = (datauri == origurl) ? "" : " data-savepage-poster=\"\"";
            
            startTag = startTag.replace(/<video/,"<video" + origstr + " poster=\"" + datauri + "\"");
            
            startTag = startTag.replace(/ data-savepage-blobdatauri="[^"]*"/,"");
        }
    }
    
    /* External audio/video/image referenced in <source> element */
    
    else if (element.localName == "source")
    {
        if (element.parentElement)
        {
            if (element.parentElement.localName == "audio" || element.parentElement.localName == "video")
            {
                if (element.getAttribute("src"))
                {
                    if (element.src == element.parentElement.currentSrc)
                    {
                        if (replaceableResourceURL(element.src))
                        {
                            baseuri = element.ownerDocument.baseURI;
                            
                            documenturi = element.ownerDocument.documentURI;
                            
                            origurl = element.getAttribute("src");
                            
                            datauri = replaceURL(origurl,baseuri,documenturi);
                            
                            origstr = (datauri == origurl) ? "" : " data-savepage-src=\"" + origurl + "\"";
                            
                            startTag = startTag.replace(/ src="[^"]*"/,origstr + " src=\"" + datauri + "\"");
                        }
                    }
                    else  /* unsaved url */
                    {
                        baseuri = element.ownerDocument.baseURI;
                        
                        documenturi = element.ownerDocument.documentURI;
                        
                        origurl = element.getAttribute("src");
                        
                        newurl = unsavedURL(origurl,baseuri,documenturi);
                        
                        origstr = (newurl == origurl) ? "" : " data-savepage-src=\"" + origurl + "\"";
                        
                        startTag = startTag.replace(/ src="[^"]*"/,origstr + " src=\"" + newurl + "\"");
                    }
                }
            }
            else if (element.parentElement.localName == "picture")
            {
                /* Remove srcset URLs - currentSrc may be set to one of these URLs - other URls are unsaved */
                
                if (element.getAttribute("srcset"))
                {
                    origurl = element.getAttribute("srcset");
                    
                    origstr = " data-savepage-srcset=\"" + origurl + "\"";
                    
                    startTag = startTag.replace(/ srcset="[^"]*"/,origstr + " srcset=\"\"");
                }
            }
        }
    }
    
    /* External subtitles referenced in <track> element */
    
    else if (element.localName == "track")
    {
        if (element.getAttribute("src"))
        {
            if (replaceableResourceURL(element.src))
            {
                baseuri = element.ownerDocument.baseURI;
                
                documenturi = element.ownerDocument.documentURI;
                
                origurl = element.getAttribute("src");
                
                datauri = replaceURL(origurl,baseuri,documenturi);
                
                origstr = (datauri == origurl) ? "" : " data-savepage-src=\"" + origurl + "\"";
                
                startTag = startTag.replace(/ src="[^"]*"/,origstr + " src=\"" + datauri + "\"");
            }
        }
    }
    
    /* External data referenced in <object> element */
    
    else if (element.localName == "object")
    {
        if (element.getAttribute("data"))
        {
            if (replaceableResourceURL(element.data))
            {
                baseuri = element.ownerDocument.baseURI;
                
                documenturi = element.ownerDocument.documentURI;
                
                origurl = element.getAttribute("data");
                
                datauri = replaceURL(origurl,baseuri,documenturi);
                
                origstr = (datauri == origurl) ? "" : " data-savepage-data=\"" + origurl + "\"";
                
                startTag = startTag.replace(/ data="[^"]*"/,origstr + " data=\"" + datauri + "\"");
            }
        }
    }
    
    /* External data referenced in <embed> element */
    
    else if (element.localName == "embed")
    {
        if (element.getAttribute("src"))
        {
            if (replaceableResourceURL(element.src))
            {
                baseuri = element.ownerDocument.baseURI;
                
                documenturi = element.ownerDocument.documentURI;
                
                origurl = element.getAttribute("src");
                
                datauri = replaceURL(origurl,baseuri,documenturi);
                
                origstr = (datauri == origurl) ? "" : " data-savepage-src=\"" + origurl + "\"";
                
                startTag = startTag.replace(/ src="[^"]*"/,origstr + " src=\"" + datauri + "\"");
            }
        }
    }
    
    /* SVG - External location referenced in <a> element */
    /* SVG - Internal location referenced in <a> element */
    
    else if (element.localName == "a" && element instanceof SVGElement)
    {
        if (element.getAttribute("href") || element.getAttribute("xlink:href"))
        {
            baseuri = element.ownerDocument.baseURI;
            
            documenturi = element.ownerDocument.documentURI;
            
            origurl = element.getAttribute("href") || element.getAttribute("xlink:href");
            
            newurl = adjustURL(origurl,baseuri,documenturi);
            
            if (newurl != origurl)
            {
                origstr = " data-savepage-href=\"" + origurl + "\"";
                
                startTag = startTag.replace(/ (?:href|xlink:href)="[^"]*"/,origstr + " href=\"" + newurl + "\"");
            }
        }
    }
    
    /* SVG - External <symbol> element referenced in <use> element */
    /* SVG - Internal <symbol> element referenced in <use> element */
    
    else if (element.localName == "use" && element instanceof SVGElement)
    {
        if (element.getAttribute("href") || element.getAttribute("xlink:href"))
        {
            baseuri = element.ownerDocument.baseURI;
            
            documenturi = element.ownerDocument.documentURI;
            
            origurl = element.getAttribute("href") || element.getAttribute("xlink:href");
            
            newurl = adjustURL(origurl,baseuri,documenturi);
            
            if (newurl.substr(0,1) != "#")  /* not fragment only */
            {
                if (replaceableResourceURL(element.href.baseVal))
                {
                    svgstr = retrieveContent(origurl,baseuri);
                    
                    parser = new DOMParser();
                    svgdoc = parser.parseFromString(svgstr,"text/html");
                    
                    if (element.href.baseVal.indexOf("#") >= 0)  /* SVG 1.1 & SVG 2 - fragment - insert fragment element and descendants */
                    {
                        svgfragid = element.href.baseVal.substr(element.href.baseVal.indexOf("#")+1);
                        svgelement = svgdoc.getElementById(svgfragid);
                        svghref = (svgelement && svgelement.localName == "symbol") ? "#" + svgfragid : "";
                    }
                    else
                    {
                        svgelement = svgdoc.body.children[0];  /* SVG 2 - no fragment - insert root <svg> element and descendants */
                        svghref = "";
                    }
                    
                    if (svgelement)
                    {
                        origstr = " data-savepage-href=\"" + origurl + "\"";
                        
                        startTag = startTag.replace(/ (?:href|xlink:href)="[^"]*"/,origstr + " href=\"" + svghref + "\"");
                        
                        endTag = endTag.replace(/>/,"><!--savepage-symbol-insert-->" + svgelement.outerHTML);
                    }
                }
            }
            else  /* fragment only */
            {
                if (newurl != origurl)
                {
                    origstr = " data-savepage-href=\"" + origurl + "\"";
                    
                    startTag = startTag.replace(/ (?:href|xlink:href)="[^"]*"/,origstr + " href=\"" + newurl + "\"");
                }
            }
        }
    }
    
    /* SVG - External resource referenced in other SVG elements */
    /* SVG - Internal resource referenced in other SVG elements */
    
    else if (hrefSVGElements.indexOf(element.localName) >= 0 && element instanceof SVGElement)
    {
        if (element.getAttribute("href") || element.getAttribute("xlink:href"))
        {
            baseuri = element.ownerDocument.baseURI;
            
            documenturi = element.ownerDocument.documentURI;
            
            origurl = element.getAttribute("href") || element.getAttribute("xlink:href");
            
            newurl = adjustURL(origurl,baseuri,documenturi);
            
            if (newurl.substr(0,1) != "#")  /* not fragment only */
            {
                if (replaceableResourceURL(element.href.baseVal))
                {
                    datauri = replaceURL(origurl,baseuri,documenturi);
                    
                    origstr = (datauri == origurl) ? "" : " data-savepage-href=\"" + origurl + "\"";
                    
                    startTag = startTag.replace(/ (?:href|xlink:href)="[^"]*"/,origstr + " href=\"" + datauri + "\"");
                }
            }
            else  /* fragment only */
            {
                if (newurl != origurl)
                {
                    origstr = " data-savepage-href=\"" + origurl + "\"";
                    
                    startTag = startTag.replace(/ (?:href|xlink:href)="[^"]*"/,origstr + " href=\"" + newurl + "\"");
                }
            }
        }
    }
    
    /* Handle nested frames and child elements & text nodes & comment nodes */
    /* Generate HTML into array of strings */
    
    if (element.localName == "iframe")  /* iframe elements */
    {
        if (pageType == 0)
        {
            if (depth < maxFrameDepth)
            {
                nosrcframe = nosrcframe || (!element.getAttribute("src") && !element.getAttribute("srcdoc"));
                
                subframekey = element.getAttribute("data-savepage-key");
                
                try
                {
                    if (element.contentDocument.documentElement != null)  /* in case web page not fully loaded before extracting */
                    {
                        startindex = htmlStrings.length;
                        
                        extractHTML(depth+1,element.contentWindow,element.contentDocument.documentElement,crossframe,nosrcframe,subframekey,preserve,indent+2);
                        
                        endindex = htmlStrings.length;
                        
                        htmltext = "";
                        
                        for (j = startindex; j < endindex; j++)
                        {
                            htmltext += htmlStrings[j];
                            htmlStrings[j] = "";
                        }
                        
                        htmltext = htmltext.replace(/&/g,"&amp;");
                        htmltext = htmltext.replace(/"/g,"&quot;");
                        
                        if (pageType == 0 && formatHTML && depth == 0)
                        {
                            htmltext = htmltext.replace(/\n/g,newlineIndent(indent+2));
                            htmltext = newlineIndent(indent+2) + "<!--savepage-srcdoc-begin-->" + newlineIndent(indent+2) + htmltext;
                            htmltext += newlineIndent(indent+2) + "<!--savepage-srcdoc-end-->";
                        }
                        
                        startTag = startTag.replace(/<iframe/,"<iframe data-savepage-sameorigin=\"\"");
                        
                        if (element.hasAttribute("srcdoc"))
                        {
                            origsrcdoc = element.getAttribute("srcdoc");
                            
                            origstr = " data-savepage-srcdoc=\"" + origsrcdoc + "\"";
                            
                            startTag = startTag.replace(/ srcdoc="[^"]*"/,origstr + " srcdoc=\"" + htmltext + "\"");
                        }
                        else startTag = startTag.replace(/<iframe/,"<iframe srcdoc=\"" + htmltext + "\"");
                    }
                }
                catch (e)  /* attempting cross-domain web page access */
                {
                    if (retainCrossFrames)
                    {
                        for (i = 0; i < frameKey.length; i++)
                        {
                            if (frameKey[i] == subframekey) break;
                        }
                        
                        if (i != frameKey.length)
                        {
                            parser = new DOMParser();
                            framedoc = parser.parseFromString(frameHTML[i],"text/html");
                            
                            startindex = htmlStrings.length;
                            
                            extractHTML(depth+1,null,framedoc.documentElement,true,nosrcframe,subframekey,preserve,indent+2);
                            
                            endindex = htmlStrings.length;
                            
                            htmltext = "";
                            
                            for (j = startindex; j < endindex; j++)
                            {
                                htmltext += htmlStrings[j];
                                htmlStrings[j] = "";
                            }
                            
                            htmltext = htmltext.replace(/&/g,"&amp;");
                            htmltext = htmltext.replace(/"/g,"&quot;");
                            
                            if (pageType == 0 && formatHTML && depth == 0)
                            {
                                htmltext = htmltext.replace(/\n/g,newlineIndent(indent+2));
                                htmltext = newlineIndent(indent+2) + "<!--savepage-srcdoc-begin-->" + newlineIndent(indent+2) + htmltext;
                                htmltext += newlineIndent(indent+2) + "<!--savepage-srcdoc-end-->";
                            }
                            
                            startTag = startTag.replace(/<iframe/,"<iframe data-savepage-crossorigin=\"\"");
                            
                            if (element.hasAttribute("srcdoc"))
                            {
                                origsrcdoc = element.getAttribute("srcdoc");
                                
                                origstr = " data-savepage-srcdoc=\"" + origsrcdoc + "\"";
                                
                                startTag = startTag.replace(/ srcdoc="[^"]*"/,origstr + " srcdoc=\"" + htmltext + "\"");
                            }
                            else startTag = startTag.replace(/<iframe/,"<iframe srcdoc=\"" + htmltext + "\"");
                            
                            if (element.hasAttribute("sandbox"))  /* prevent scripts executing in cross-origin frames */
                            {
                                origsandbox = element.getAttribute("sandbox");
                                
                                origstr = " data-savepage-sandbox=\"" + origsandbox + "\"";
                                
                                startTag = startTag.replace(/ sandbox="[^"]*"/,origstr + " sandbox=\"allow-scripts\"");
                            }
                            else startTag = startTag.replace(/<iframe/,"<iframe sandbox=\"allow-scripts\"");
                        }
                    }
                }
            }
            
            if (element.hasAttribute("src"))
            {
                origurl = element.getAttribute("src");
                
                origstr = " data-savepage-src=\"" + origurl + "\"";
                
                startTag = startTag.replace(/ src="[^"]*"/,origstr + " src=\"\"");
            }
            
            if (pageType == 0 && formatHTML && depth == 0 && !inline && parentpreserve == 0) htmlStrings[htmlStrings.length] = newlineIndent(indent);
        }
        
        htmlStrings[htmlStrings.length] = startTag;
        htmlStrings[htmlStrings.length] = endTag;
    }
    else if (element.localName == "frame")  /* frame elements */
    {
        if (pageType == 0)
        {
            datauri = null;
            
            if (depth < maxFrameDepth)
            {
                nosrcframe = nosrcframe || !element.getAttribute("src");
                
                subframekey = element.getAttribute("data-savepage-key");
                
                try
                {
                    if (element.contentDocument.documentElement != null)  /* in case web page not fully loaded before extracting */
                    {
                        startindex = htmlStrings.length;
                        
                        extractHTML(depth+1,element.contentWindow,element.contentDocument.documentElement,crossframe,nosrcframe,subframekey,preserve,indent+2);
                        
                        endindex = htmlStrings.length;
                        
                        htmltext = "";
                        
                        for (j = startindex; j < endindex; j++)
                        {
                            htmltext += htmlStrings[j];
                            htmlStrings[j] = "";
                        }
                        
                        datauri = "data:text/html;charset=utf-8," + encodeURIComponent(htmltext);
                        
                        startTag = startTag.replace(/<frame/,"<frame data-savepage-sameorigin=\"\"");
                        
                        if (element.hasAttribute("src"))
                        {
                            origurl = element.getAttribute("src");
                            
                            origstr = " data-savepage-src=\"" + origurl + "\"";
                            
                            startTag = startTag.replace(/ src="[^"]*"/,origstr + " src=\"" + datauri + "\"");
                        }
                        else startTag = startTag.replace(/<frame/,"<frame src=\"" + datauri + "\"");
                    }
                }
                catch (e)  /* attempting cross-domain web page access */
                {
                    if (retainCrossFrames)
                    {
                        for (i = 0; i < frameKey.length; i++)
                        {
                            if (frameKey[i] == subframekey) break;
                        }
                        
                        if (i != frameKey.length)
                        {
                            parser = new DOMParser();
                            framedoc = parser.parseFromString(frameHTML[i],"text/html");
                            
                            startindex = htmlStrings.length;
                            
                            extractHTML(depth+1,null,framedoc.documentElement,true,nosrcframe,subframekey,preserve,indent+2);
                            
                            endindex = htmlStrings.length;
                            
                            htmltext = "";
                            
                            for (j = startindex; j < endindex; j++)
                            {
                                htmltext += htmlStrings[j];
                                htmlStrings[j] = "";
                            }
                            
                            datauri = "data:text/html;charset=utf-8," + encodeURIComponent(htmltext);
                            
                            startTag = startTag.replace(/<frame/,"<frame data-savepage-crossorigin=\"\"");
                            
                            if (element.hasAttribute("src"))
                            {
                                origurl = element.getAttribute("src");
                                
                                origstr = " data-savepage-src=\"" + origurl + "\"";
                                
                                startTag = startTag.replace(/ src="[^"]*"/,origstr + " src=\"" + datauri + "\"");
                            }
                            else startTag = startTag.replace(/<frame/,"<frame src=\"" + datauri + "\"");
                        }
                    }
                }
            }
            
            if (datauri == null)
            {
                if (element.getAttribute("src"))  /* unsaved url */
                {
                    baseuri = element.ownerDocument.baseURI;
                    
                    documenturi = element.ownerDocument.documentURI;
                    
                    origurl = element.getAttribute("src");
                    
                    newurl = unsavedURL(origurl,baseuri,documenturi);
                    
                    origstr = (newurl == origurl) ? "" : " data-savepage-src=\"" + origurl + "\"";
                    
                    startTag = startTag.replace(/ src="[^"]*"/,origstr + " src=\"" + newurl + "\"");
                }
            }
            
            if (pageType == 0 && formatHTML && depth == 0 && !inline && parentpreserve == 0) htmlStrings[htmlStrings.length] = newlineIndent(indent);
        }
        
        htmlStrings[htmlStrings.length] = startTag;
    }
    else
    {
        if (element.localName == "html")
        {
            /* Add !DOCTYPE declaration */
            
            doctype = element.ownerDocument.doctype;
            
            if (doctype != null)
            {
                htmltext = '<!DOCTYPE ' + doctype.name + (doctype.publicId ? ' PUBLIC "' + doctype.publicId + '"' : '') +
                           ((doctype.systemId && !doctype.publicId) ? ' SYSTEM' : '') + (doctype.systemId ? ' "' + doctype.systemId + '"' : '') + '>';
                
                htmlStrings[htmlStrings.length] = htmltext;
            }
            
            htmlStrings[htmlStrings.length] = startTag;
        }
        else if (element.localName == "head")
        {
            if (formatHTML && depth == 0) htmlStrings[htmlStrings.length] = newlineIndent(indent);
            htmlStrings[htmlStrings.length] = startTag;
            
            prefix = (formatHTML && depth == 0) ? "\n    " : "\n";

            /* Add first favicon from document head or if none add favicon from website root */
            
            if (depth == 0 && (firstIconLocation != "" || rootIconLocation != ""))
            {
                baseuri = element.ownerDocument.baseURI;
                
                documenturi = element.ownerDocument.documentURI;
                
                location = (firstIconLocation != "") ? firstIconLocation : rootIconLocation;
                
                datauri = replaceURL(location,baseuri,documenturi);
                
                htmltext = prefix + "<link rel=\"icon\" data-savepage-href=\"" + location + "\" href=\"" + datauri + "\">";
                
                htmlStrings[htmlStrings.length] = htmltext;
            }
        }
        else if (startTag != "")
        {
            if (pageType == 0 && formatHTML && depth == 0 && !inline && parentpreserve == 0) htmlStrings[htmlStrings.length] = newlineIndent(indent);
            htmlStrings[htmlStrings.length] = startTag;
        }
        
        if (element.localName == "style" ||  /* <style> element */
            element.localName == "script" ||  /* <script> element */
            (element.localName == "link" && !(element.parentElement instanceof SVGElement) &&  /* <link> is invalid inside <svg> */
             element.rel.toLowerCase().indexOf("stylesheet") >= 0 && element.getAttribute("href")))  /* <link rel="stylesheet" href="..."> element */
        {
            if (formatHTML && depth == 0)
            {
                textContent = textContent.trim();
                if (pageType == 0) textContent = textContent.replace(/\n/g,newlineIndent(indent+2));
                if (textContent != "") textContent = newlineIndent(indent+2) + textContent;
                textContent += newlineIndent(indent);
            }
            
            htmlStrings[htmlStrings.length] = textContent;
        }
        else if (element.localName == "textarea")  /* <textarea> element */
        {
            textContent = textContent.replace(/&/g,"&amp;");
            textContent = textContent.replace(/</g,"&lt;");
            textContent = textContent.replace(/>/g,"&gt;");
            
            htmlStrings[htmlStrings.length] = textContent;
        }
        else if (voidElements.indexOf(element.localName) >= 0) ;  /* void element */
        else
        {
            /* Handle shadow child nodes */
            
            if (isFirefox) shadowroot = element.shadowRoot || element.openOrClosedShadowRoot;
            else shadowroot = element.shadowRoot || ((chrome.dom && element instanceof HTMLElement) ? chrome.dom.openOrClosedShadowRoot(element) : null);
            
            if (shadowroot != null)
            {
                if (shadowElements.indexOf(element.localName) < 0)  /* ignore elements with built-in Shadow DOM */
                {
                    if (pageType == 0 && formatHTML && depth == 0)
                    {
                        htmlStrings[htmlStrings.length] = newlineIndent(indent);
                        indent += 2;
                    }
                    
                    htmlStrings[htmlStrings.length] = "<template data-savepage-shadowroot=\"\">";
                    
                    for (i = 0; i < shadowroot.childNodes.length; i++)
                    {
                        if (shadowroot.childNodes[i] != null)  /* in case web page not fully loaded before extracting */
                        {
                            if (shadowroot.childNodes[i].nodeType == 1)  /* element node */
                            {
                                extractHTML(depth,frame,shadowroot.childNodes[i],crossframe,nosrcframe,framekey,preserve,indent+2);
                            }
                            else if (shadowroot.childNodes[i].nodeType == 3)  /* text node */
                            {
                                text = shadowroot.childNodes[i].textContent;
                                
                                if (shadowroot.localName != "noscript")
                                {
                                    text = text.replace(/&/g,"&amp;");
                                    text = text.replace(/</g,"&lt;");
                                    text = text.replace(/>/g,"&gt;");
                                }
                                
                                if (pageType == 0 && formatHTML && depth == 0)
                                {
                                    /* HTML whitespace == HTML space characters == spaces + newlines */
                                    /* HTML spaces: space (U+0020), tab (U+0009), form feed (U+000C) */
                                    /* HTML newlines: line feed (U+000A) or carriage return (U+000D) */
                                    
                                    if (preserve == 0) text = text.replace(/[\u0020\u0009\u000C\u000A\u000D]+/g," ");
                                    else if (preserve == 1) text = text.replace(/[\u0020\u0009\u000C]+/g," ");
                                }
                                
                                htmlStrings[htmlStrings.length] = text;
                            }
                            else if (shadowroot.childNodes[i].nodeType == 8)  /* comment node */
                            {
                                text = shadowroot.childNodes[i].textContent;
                                
                                if (pageType == 0 && formatHTML && depth == 0 && !inline && preserve == 0)
                                {
                                    text = text.replace(/\n/g,newlineIndent(indent+2));
                                    
                                    htmlStrings[htmlStrings.length] = newlineIndent(indent+2);
                                }
                                
                                htmlStrings[htmlStrings.length] = "<!--" + text + "-->";
                            }
                        }
                    }
                    
                    if (pageType == 0 && formatHTML && depth == 0)
                    {
                        indent -= 2;
                        htmlStrings[htmlStrings.length] = newlineIndent(indent);
                    }
                    
                    htmlStrings[htmlStrings.length] = "</template>";
                }
            }
            
            /* Handle normal child nodes */
            
            for (i = 0; i < element.childNodes.length; i++)
            {
                if (element.childNodes[i] != null)  /* in case web page not fully loaded before extracting */
                {
                    if (element.childNodes[i].nodeType == 1)  /* element node */
                    {
                        if (depth == 0)
                        {
                            if (element.childNodes[i].localName == "iframe" && element.childNodes[i].id.substr(0,8) == "savepage") continue;
                            if (element.childNodes[i].localName == "script" && element.childNodes[i].id.substr(0,8) == "savepage") continue;
                            if (element.childNodes[i].localName == "meta" && element.childNodes[i].name.substr(0,8) == "savepage") continue;
                        }
                        
                        /* Handle other element nodes */
                        
                        extractHTML(depth,frame,element.childNodes[i],crossframe,nosrcframe,framekey,preserve,indent+2);
                    }
                    else if (element.childNodes[i].nodeType == 3)  /* text node */
                    {
                        text = element.childNodes[i].textContent;
                        
                        /* Skip text nodes before skipped elements/comments and at end of <head>/<body> elements */
                        
                        if (pageType > 0 && formatHTML && depth == 0)
                        {
                            if (text.trim() == "" && (i+1) < element.childNodes.length && element.childNodes[i+1].nodeType == 1)
                            {
                                if (element.childNodes[i+1].localName == "base") continue;
                                if (element.childNodes[i+1].localName == "iframe" && element.childNodes[i+1].id.substr(0,8) == "savepage") continue;
                                if (element.childNodes[i+1].localName == "script" && element.childNodes[i+1].id.substr(0,8) == "savepage") continue;
                                if (element.childNodes[i+1].localName == "meta" && element.childNodes[i+1].name.substr(0,8) == "savepage") continue;
                            }
                                
                            if (text.trim() == "" && (i+1) < element.childNodes.length && element.childNodes[i+1].nodeType == 8)
                            {
                                if (element.childNodes[i+1].textContent.indexOf("SAVE PAGE WE") >= 0) continue;
                            }
                            
                            if (text.trim() == "" && i == element.childNodes.length-1)
                            {
                                if (element.localName == "head") continue;
                                if (element.localName == "body") continue;
                            }
                        }
                        
                        /* Handle other text nodes */
                        
                        if (element.localName != "noscript")
                        {
                            text = text.replace(/&/g,"&amp;");
                            text = text.replace(/</g,"&lt;");
                            text = text.replace(/>/g,"&gt;");
                        }
                        
                        if (pageType == 0 && formatHTML && depth == 0)
                        {
                            /* HTML whitespace == HTML space characters == spaces + newlines */
                            /* HTML spaces: space (U+0020), tab (U+0009), form feed (U+000C) */
                            /* HTML newlines: line feed (U+000A) or carriage return (U+000D) */
                            
                            if (preserve == 0) text = text.replace(/[\u0020\u0009\u000C\u000A\u000D]+/g," ");
                            else if (preserve == 1) text = text.replace(/[\u0020\u0009\u000C]+/g," ");
                        }
                        
                        htmlStrings[htmlStrings.length] = text;
                    }
                    else if (element.childNodes[i].nodeType == 8)  /* comment node */
                    {
                        text = element.childNodes[i].textContent;
                        
                        /* Skip existing Save Page WE metrics and resource summary comment */
                        
                        if (text.indexOf("SAVE PAGE WE") >= 0) continue;
                        
                        /* Handle other comment nodes */
                        
                        if (pageType == 0 && formatHTML && depth == 0 && !inline && preserve == 0)
                        {
                            text = text.replace(/\n/g,newlineIndent(indent+2));
                            
                            htmlStrings[htmlStrings.length] = newlineIndent(indent+2);
                        }
                        
                        htmlStrings[htmlStrings.length] = "<!--" + text + "-->";
                    }
                }
            }
        }
        
        if (element.localName == "html" || element.localName == "body")
        {
            if (formatHTML && depth == 0) htmlStrings[htmlStrings.length] = newlineIndent(indent);
            htmlStrings[htmlStrings.length] = endTag;
        }
        else if (element.localName == "head")
        {
            prefix = (formatHTML && depth == 0) ? "\n    " : "\n";
            
            /* Add <style> element containing CSS URL variables */
            
            if (pageType == 0 && mergeCSSImages)
            {
                htmltext = prefix + "<style id=\"savepage-cssvariables\">";
                htmltext += prefix + "  :root {";
                
                for (i = 0; i < resourceLocation.length; i++)
                {
                    if (resourceCSSFrameKeys[i][framekey] == true)
                    {
                        try { asciistring = btoa(resourceContent[i]); }
                        catch (e) { asciistring = ""; }  /* resource content not a binary string */
                        
                        htmltext += prefix + "    --savepage-url-" + i + ": url(data:" + resourceMimeType[i] + ";base64," + asciistring + ");";   /* binary data encoded as Base64 ASCII string */
                    }
                }
                
                htmltext += prefix + "  }";
                htmltext += prefix + "</style>";
                
                htmlStrings[htmlStrings.length] = htmltext;
            }
            
            if (depth == 0)
            {
                /* Add shadow loader script */
                
                htmltext = prefix + "<script id=\"savepage-shadowloader\" type=\"text/javascript\">";
                htmltext += prefix + "  \"use strict\";";
                htmltext += prefix + "  window.addEventListener(\"DOMContentLoaded\",";
                htmltext += prefix + "  function(event) {";
                htmltext += prefix + "    savepage_ShadowLoader(" + maxFrameDepth + ");";
                htmltext += prefix + "  },false);";
                htmltext += prefix + "  " + shadowLoader;
                htmltext += prefix + "</script>";
                
                htmlStrings[htmlStrings.length] = htmltext;
                
                /* Add page info bar html, css and script */
                
                if (includeInfoBar)
                {
                    date = new Date();
                    
                    pageurl = (pageType == 0) ? document.URL : document.querySelector("meta[name='savepage-url']").content;
                    
                    pageinfoBar = pageinfoBar.replace(/%URL%/,pageurl);
                    pageinfoBar = pageinfoBar.replace(/%DECODED-URL%/,decodeURIComponent(pageurl).replace(/'/g,"\\'"));
                    pageinfoBar = pageinfoBar.replace(/%DATE%/,date.toDateString().substr(8,2) + " " + date.toDateString().substr(4,3) + " " + date.toDateString().substr(11,4));
                    pageinfoBar = pageinfoBar.replace(/%TIME%/,date.toTimeString().substr(0,8));
                    
                    htmltext = prefix + "<script id=\"savepage-pageinfo-bar-insert\" type=\"text/javascript\">";
                    htmltext += prefix + "  \"use strict\";";
                    htmltext += prefix + "  window.addEventListener('load',function(event) {";
                    htmltext += prefix + "    var parser = new DOMParser();";
                    htmltext += prefix + "    var pageinfodoc = parser.parseFromString('" + pageinfoBar + "','text/html');";
                    htmltext += prefix + "    var container = document.createElement('div');";
                    htmltext += prefix + "    container.setAttribute('id','savepage-pageinfo-bar-container');";
                    htmltext += prefix + "    document.documentElement.appendChild(container);";
                    htmltext += prefix + "    container.appendChild(pageinfodoc.getElementById('savepage-pageinfo-bar-style'));";
                    htmltext += prefix + "    container.appendChild(pageinfodoc.getElementById('savepage-pageinfo-bar-content'));";
                    htmltext += prefix + "    document.getElementById('savepage-pageinfo-bar-button').addEventListener('click',function(event) {";
                    htmltext += prefix + "      var container = document.getElementById('savepage-pageinfo-bar-container');";
                    htmltext += prefix + "      document.documentElement.removeChild(container);";
                    htmltext += prefix + "    },false);";
                    htmltext += prefix + "  },false);";
                    htmltext += prefix + "</script>";
                    
                    htmlStrings[htmlStrings.length] = htmltext;
                }
                
                /* Add saved page information */
                
                date = new Date();
                datestr = date.toString();
                
                if ((pubelement = document.querySelector("meta[property='article:published_time'][content]")) != null) pubstr = pubelement.getAttribute("content");  /* Open Graph - ISO8601 */
                else if ((pubelement = document.querySelector("meta[property='datePublished'][content]")) != null) pubstr = pubelement.getAttribute("content");  /* Generic RDFa - ISO8601 */
                else if ((pubelement = document.querySelector("meta[itemprop='datePublished'][content]")) != null) pubstr = pubelement.getAttribute("content");  /* Microdata - ISO8601 */
                else if ((pubelement = document.querySelector("script[type='application/ld+json']")) != null)  /* JSON-LD - ISO8601 */
                {
                    pubmatches = pubelement.textContent.match(/"datePublished"\s*:\s*"([^"]*)"/);
                    pubstr = pubmatches ? pubmatches[1] : null;
                }
                else if ((pubelement = document.querySelector("time[datetime]")) != null) pubstr = pubelement.getAttribute("datetime");  /* HTML5 - ISO8601 and similar formats */
                else pubstr = null;
                
                try 
                {
                    if (!pubstr) throw false;
                    pubmatches = pubstr.match(/(Z|(-|\+)\d\d:?\d\d)$/);
                    pubzone = pubmatches ? (pubmatches[1] == "Z" ? " GMT+0000" : " GMT" + pubmatches[1].replace(":","")) : "";  /* extract timezone */
                    pubstr = pubstr.replace(/(Z|(-|\+)\d\d:?\d\d)$/,"");  /* remove timezone */
                    pubdate = new Date(pubstr);
                    pubdatestr = pubdate.toString();
                    pubdatestr = pubdatestr.substr(0,24) + pubzone;
                }
                catch (e) { pubdatestr = "Unknown"; }
                
                if (savedItems == 0)
                {
                    state = "Basic Items;";
                }
                else if (savedItems == 1)
                {
                    state = "Standard Items;";
                }
                else if (savedItems == 2)
                {
                    state = "Custom Items;";
                    if (saveHTMLImagesAll) state += " HTML image files (all);";
                    if (saveHTMLAudioVideo) state += " HTML audio & video files;";
                    if (saveHTMLObjectEmbed) state += " HTML object & embed files;";
                    if (saveCSSImagesAll) state += " CSS image files (all);";
                    if (saveCSSFontsAll) state += " CSS font files (all);";
                    else if (saveCSSFontsWoff) state += " CSS font files (woff for any browser);";
                    if (saveScripts) state += " Scripts (in same-origin frames);";
                }
                
                if (retainCrossFrames) state += " Retain cross-origin frames;";
                if (mergeCSSImages) state += " Merge CSS images;";
                if (executeScripts) state += " Allow scripts to execute;";
                if (removeUnsavedURLs) state += " Remove unsaved URLs;";
                if (removeElements) state += " Remove hidden elements;";
                if (rehideElements) state += " Rehide hidden elements;";
                if (allowPassive) state += " Allow passive mixed content;";
                if (crossOrigin == 1) state += " Send referrer headers with origin and path;";
                
                if (loadLazyContent)
                {
                    state += " Load lazy content - ";
                    if (lazyLoadType == 0) state += "scroll steps = " + lazyLoadScrollTime + "s;";
                    else if (lazyLoadType == 1) state += "shrink checks = " + lazyLoadShrinkTime + "s;";
                }
                
                if (loadLazyImages) state += " Load lazy images in existing content;";
                
                state += " Max frame depth = " + maxFrameDepth + ";";
                state += " Max resource size = " + maxResourceSize + "MB;";
                state += " Max resource time = " + maxResourceTime + "s;";
                
                pageurl = (pageType == 0) ? document.URL : document.querySelector("meta[name='savepage-url']").content;
                
                htmltext = prefix + "<meta name=\"savepage-url\" content=\"" + decodeURIComponent(pageurl) + "\">";
                htmltext += prefix + "<meta name=\"savepage-title\" content=\"" + document.title + "\">";
                htmltext += prefix + "<meta name=\"savepage-pubdate\" content=\"" + pubdatestr + "\">";
                htmltext += prefix + "<meta name=\"savepage-from\" content=\"" + decodeURIComponent(document.URL) + "\">";
                htmltext += prefix + "<meta name=\"savepage-date\" content=\"" + datestr + "\">";
                htmltext += prefix + "<meta name=\"savepage-state\" content=\"" + state + "\">";
                htmltext += prefix + "<meta name=\"savepage-version\" content=\"" + chrome.runtime.getManifest().version + "\">";
                htmltext += prefix + "<meta name=\"savepage-comments\" content=\"" + enteredComments + "\">";
                    
                htmlStrings[htmlStrings.length] = htmltext;
            }
            
            htmlStrings[htmlStrings.length] = newlineIndent(indent);
            htmlStrings[htmlStrings.length] = endTag;
        }
        else if (endTag != "")
        {
            if (pageType == 0 && formatHTML && depth == 0 && !inline && preserve == 0 && element.children.length > 0)
            {
                htmlStrings[htmlStrings.length] = newlineIndent(indent);
            }
            
            htmlStrings[htmlStrings.length] = endTag;
        }
    }
}

function replaceCSSURLsInStyleSheet(csstext,baseuri,documenturi,importstack,framekey)
{
    var regex;
    var matches = [];
    
    /* @import url() or */
    /* @font-face rule with font url()'s or */
    /* image url() or */
    /* avoid matches inside double-quote strings or */
    /* avoid matches inside single-quote strings or */
    /* avoid matches inside comments */
    
    regex = new RegExp(/(?:( ?)@import\s*(?:url\(\s*)?((?:"[^"]+")|(?:'[^']+')|(?:[^\s);]+))(?:\s*\))?\s*;)|/.source +  /* p1 & p2 */
                       /(?:( ?)@font-face\s*({[^}]*}))|/.source +  /* p3 & p4 */
                       /(?:( ?)url\(\s*((?:"[^"]+")|(?:'[^']+')|(?:[^\s)]+))\s*\))|/.source +  /* p5 & p6 */
                       /(?:"(?:\\"|[^"])*")|/.source +
                       /(?:'(?:\\'|[^'])*')|/.source +
                       /(?:\/\*(?:\*[^\/]|[^\*])*?\*\/)/.source,
                       "gi");
    
    csstext = csstext.replace(regex,_replaceCSSURLOrImportStyleSheet);
    
    return csstext;
    
    function _replaceCSSURLOrImportStyleSheet(match,p1,p2,p3,p4,p5,p6,offset,string)
    {
        var i,location,csstext,newurl,datauriorcssvar,origstr,urlorvar;
        
        if (match.trim().substr(0,7).toLowerCase() == "@import")  /* @import url() */
        {
            p2 = removeQuotes(p2);
            
            if (replaceableResourceURL(p2))
            {
                if (baseuri != null)
                {
                    location = resolveURL(p2,baseuri);
                    
                    if (location != null)
                    {
                        location = removeFragment(location);
                        
                        for (i = 0; i < resourceLocation.length; i++)
                            if (resourceLocation[i] == location && resourceStatus[i] == "success") break;
                        
                        if (i < resourceLocation.length)  /* style sheet found */
                        {
                            if (importstack.indexOf(location) < 0)
                            {
                                importstack.push(location);
                                
                                csstext = replaceCSSURLsInStyleSheet(resourceContent[i],resourceLocation[i],resourceLocation[i],importstack,framekey);
                                
                                importstack.pop();
                                
                                return p1 + "/*savepage-import-url=" + p2 + "*/" + p1 + csstext;
                            }
                        }
                    }
                }
                
                if (removeUnsavedURLs) return p1 + "/*savepage-import-url=" + p2 + "*/" + p1;
                else
                {
                    newurl = adjustURL(p2,baseuri,documenturi);
                    
                    if (newurl != p2)
                    {
                        match = match.replace(p2,newurl);
                        match = match.replace(/(@import)/i,"/*savepage-import-url=" + p2 + "*/" + p1 + "$1");
                        return match;
                    }
                    else return match;  /* original @import rule */
                }
            }
        }
        else if (match.trim().substr(0,10).toLowerCase() == "@font-face")  /* @font-face rule */
        {
            match = match.replace(/font-display\s*:\s*([^\s;}]*)\s*;?/gi,"/*savepage-font-display=$1*/");  /* remove font-display to avoid Chrome using fallback font */
            
            regex = /( ?)url\(\s*((?:"[^"]+")|(?:'[^']+')|(?:[^\s)]+))\s*\)/gi;  /* font url() */
            
            return match.replace(regex,_replaceURL);
            
            function _replaceURL(match,p1,p2,offset,string)
            {
                var cssvar,datauri,origstr;
                
                p2 = removeQuotes(p2);
                
                if (replaceableResourceURL(p2))
                {
                    datauri = replaceURL(p2,baseuri,documenturi);
                    
                    origstr = (datauri == p2) ? p1 : p1 + "/*savepage-url=" + p2 + "*/" + p1;
                    
                    return origstr + "url(" + datauri + ")";
                }
                else return match;  /* unreplaceable - original font url() */ 
            }
        }
        else if (match.trim().substr(0,4).toLowerCase() == "url(")  /* image url() */
        {
            p6 = removeQuotes(p6);
            
            if (replaceableResourceURL(p6))
            {
                datauriorcssvar = replaceCSSImageURL(p6,baseuri,documenturi,framekey);
                
                origstr = (datauriorcssvar == p6) ? p5 : p5 + "/*savepage-url=" + p6 + "*/" + p5;
                
                urlorvar = (datauriorcssvar.substr(0,2) == "--") ? "var" : "url";
                
                return origstr + urlorvar + "(" + datauriorcssvar + ")";
            }
            else return match;  /* unreplaceable - original image url() */ 
        }
        else if (match.substr(0,1) == "\"") return match;  /* double-quote string */
        else if (match.substr(0,1) == "'") return match;  /* single-quote string */
        else if (match.substr(0,2) == "/*") return match;  /* comment */
    }
}

function replaceCSSImageURLs(csstext,baseuri,documenturi,framekey)
{
    var regex;
    
    regex = /( ?)url\(\s*((?:"[^"]+")|(?:'[^']+')|(?:[^\s)]+))\s*\)/gi;  /* image url() */
    
    csstext = csstext.replace(regex,_replaceCSSImageURL);
    
    return csstext;
    
    function _replaceCSSImageURL(match,p1,p2,offset,string)
    {
        var datauriorcssvar,origstr,urlorvar;
        
        p2 = removeQuotes(p2);
        
        if (replaceableResourceURL(p2))
        {
            datauriorcssvar = replaceCSSImageURL(p2,baseuri,documenturi,framekey);
            
            origstr = (datauriorcssvar == p2) ? p1 : p1 + "/*savepage-url=" + p2 + "*/" + p1;
            
            urlorvar = (datauriorcssvar.substr(0,2) == "--") ? "var" : "url";
            
            return origstr + urlorvar + "(" + datauriorcssvar + ")";
        }
        else return match;  /* unreplaceable - original image url() */
    }
}

function replaceCSSImageURL(url,baseuri,documenturi,framekey)
{
    var i,location,count,asciistring;
    
    if (pageType > 0) return url;  /* saved page - ignore new resources when re-saving */
    
    if (baseuri != null)
    {
        url = url.replace(/\\26 ?/g,"&");  /* remove CSS escape */
        url = url.replace(/\\3[Aa] ?/g,":");  /* remove CSS escape */
        url = url.replace(/\\3[Dd] ?/g,"=");  /* remove CSS escape */
        
        location = resolveURL(url,baseuri);
        
        if (location != null)
        {
            location = removeFragment(location);
            
            for (i = 0; i < resourceLocation.length; i++)
                if (resourceLocation[i] == location && resourceStatus[i] == "success") break;
            
            if (i < resourceLocation.length)
            {
                if (resourceCharSet[i] == "")  /* charset not defined - binary data */
                {
                    count = mergeCSSImages ? resourceRemembered[i]-resourceCSSRemembered[i]+Object.keys(resourceCSSFrameKeys[i]).length : resourceRemembered[i];
                    
                    if (resourceContent[i].length*count <= maxResourceSize*1024*1024)  /* skip large and/or repeated resource */
                    {
                        if (mergeCSSImages)
                        {
                            if (resourceCSSFrameKeys[i][framekey] == true)
                            {
                                resourceReplaced[i]++;
                                
                                return "--savepage-url-" + i;
                            }
                        }
                        else
                        {
                            resourceReplaced[i]++;
                            
                            try { asciistring = btoa(resourceContent[i]); }
                            catch (e) { asciistring = ""; }  /* resource content not a binary string */
                            
                            return "data:" + resourceMimeType[i] + ";base64," + asciistring;  /* binary data encoded as Base64 ASCII string */
                        }
                    }
                }
            }
        }
    }
    
    return unsavedURL(url,baseuri,documenturi);  /* unsaved url */
}

function replaceURL(url,baseuri,documenturi)
{
    var i,location,fragment,count,asciistring;
    
    if (pageType > 0) return url;  /* saved page - ignore new resources when re-saving */
    
    if (baseuri != null)
    {
        location = resolveURL(url,baseuri);
        
        if (location != null)
        {
            i = location.indexOf("#");
            
            fragment = (i >= 0) ? location.substr(i) : "";
            
            location = removeFragment(location);
            
            for (i = 0; i < resourceLocation.length; i++)
                if (resourceLocation[i] == location && resourceStatus[i] == "success") break;
            
            if (i < resourceLocation.length)
            {
                if (resourceCharSet[i] == "")  /* charset not defined - binary data */
                {
                    count = resourceRemembered[i];
                    
                    if (resourceContent[i].length*count <= maxResourceSize*1024*1024)  /* skip large and/or repeated resource */
                    {
                        resourceReplaced[i]++;
                        
                        try { asciistring = btoa(resourceContent[i]); }
                        catch (e) { asciistring = ""; }  /* resource content not a binary string */
                        
                        return "data:" + resourceMimeType[i] + ";base64," + asciistring  + fragment;  /* binary data encoded as Base64 ASCII string */
                    }
                }
                else  /* charset defined - character data */
                {
                    resourceReplaced[i]++;
                    
                    return "data:" + resourceMimeType[i] + ";charset=utf-8," + encodeURIComponent(resourceContent[i]) + fragment;  /* characters encoded as UTF-8 %escaped string */
                }
            }
        }
    }
    
    return unsavedURL(url,baseuri,documenturi);  /* unsaved url */
}

function retrieveContent(url,baseuri)
{
    var i,location;
    
    if (pageType > 0) return "";  /* saved page - ignore new resources when re-saving */
    
    if (baseuri != null)
    {
        location = resolveURL(url,baseuri);
        
        if (location != null)
        {
            location = removeFragment(location);
            
            for (i = 0; i < resourceLocation.length; i++)
                if (resourceLocation[i] == location && resourceStatus[i] == "success") break;
            
            if (i < resourceLocation.length)
            {
                if (resourceCharSet[i] != "")  /* charset defined - character data */
                {
                    resourceReplaced[i]++;
                    
                    return resourceContent[i];
                }
            }
        }
    }
    
    return "";  /* empty string */
}

function adjustURL(url,baseuri,documenturi)
{
    var i,location;
    
    if (baseuri != null)
    {
        location = resolveURL(url,baseuri);
        
        if (location != null)
        {
            i = location.indexOf("#");
            
            if (i < 0)  /* without fragment */
            {
                return location;  /* same or different page - make absolute */
            }
            else  /* with fragment */
            {
                if (location.substr(0,i) == documenturi) return location.substr(i);  /* same page - make fragment only */
                else return location;  /* different page - make absolute */
            }
        }
    }
    
    return url;
}

function unsavedURL(url,baseuri,documenturi)
{
    if (removeUnsavedURLs) return "";  /* empty string */
    else return adjustURL(url,baseuri,documenturi);  /* original or adjusted url */
}

function createCanvasDataURL(url,baseuri,documenturi,element)
{
    var canvas,context;
    
    canvas = document.createElement("canvas");
    canvas.width = element.clientWidth;
    canvas.height = element.clientHeight;
    
    try
    {
        context = canvas.getContext("2d");
        context.drawImage(element,0,0,canvas.width,canvas.height);
        return canvas.toDataURL("image/png","");
    }
    catch (e) {}
    
    return unsavedURL(url,baseuri,documenturi);  /* unsaved url */
}

function swapScreenAndPrintDevices(csstext)
{
    var regex;
    
    regex = /@media[^{]*{/gi;  /* @media rule */
        
    csstext = csstext.replace(regex,_replaceDevice);
    
    return csstext;
    
    function _replaceDevice(match,offset,string)
    {
        match = match.replace(/screen/gi,"######");
        match = match.replace(/print/gi,"screen");
        match = match.replace(/######/gi,"print");
        
        return match;
    }
}

function newlineIndent(indent)
{
    var i,str;
    
    str = "\n";
    
    for (i = 0; i < indent; i++) str += " ";
    
    return str;
}

/* viewSavedPageInfo, removeResourceLoader, extractSavedPageMedia, showMessage — stripped (Browser Recall: no UI panels) */

/* Stub showMessage for any remaining error-path calls */
function showMessage(messagetitle,buttonsuffix,messagetext,continuefunction,cancelfunction)
{
    console.warn("[savepage]", messagetitle, messagetext);
    if (cancelfunction) cancelfunction();
}

function removeQuotes(url)
{
    if (url.substr(0,1) == "\"" || url.substr(0,1) == "'") url = url.substr(1);
    
    if (url.substr(-1) == "\"" || url.substr(-1) == "'") url = url.substr(0,url.length-1);
    
    return url;
}

function replaceableResourceURL(url)
{
    /* Exclude data: urls, blob: urls, moz-extension: urls, fragment-only urls and empty urls */
    
    if (url.substr(0,5).toLowerCase() == "data:" || url.substr(0,5).toLowerCase() == "blob:" ||
        url.substr(0,14).toLowerCase() == "moz-extension:" || url.substr(0,1) == "#" || url == "") return false;
    
    return true;
}

function resolveURL(url,baseuri)
{
    var resolvedURL;
    
    try
    {
        resolvedURL = new URL(url,baseuri);
    }
    catch (e)
    {
        return null;  /* baseuri invalid or null */
    }
    
    return resolvedURL.href;
}

function removeFragment(url)
{
    var i;
    
    i = url.indexOf("#");
    
    if (i >= 0) return url.substr(0,i);
    
    return url;
}

/************************************************************************/
