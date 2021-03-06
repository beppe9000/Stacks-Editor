import { Node as ProsemirrorNode } from "prosemirror-model";
import { Decoration, DecorationSet, EditorView } from "prosemirror-view";
import {
    AsyncPlugin,
    AsyncPluginKey,
} from "../../shared/prosemirror-plugins/plugin-extensions";

// TODO naive cache, maybe we can improve?
// TODO maybe we can prefill the cache if the consuming process already has the result
/** The cache of url -> content for link previews so we don't have to continually refetch */
const previewResultCache: { [url: string]: Node } = {};

/**
 * Interface to describe a link preview provider for registering/fetching previews from urls
 */
export interface LinkPreviewProvider {
    /** A regular expression to test against a url to see if this provider should handle it */
    domainTest: RegExp;
    /** The async function to render the preview */
    renderer: (url: string) => Promise<Node | null>;
}

/**
 * Gets the first valid provider for a node from all registered providers
 * @param providers All registered providers
 * @param node The node to check for applicable links to match to the registered providers
 */
function getValidProvider(
    providers: LinkPreviewProvider[],
    node: ProsemirrorNode
): { url: string; provider: LinkPreviewProvider } {
    // not a valid node, keep checking
    if (!isPreviewableLink(node)) {
        return null;
    }

    const child = node.content.firstChild;
    const url = child.marks.find((m) => m.type.name === "link")?.attrs
        ?.href as string;

    // if there is no href, then nothing will match
    if (!url) {
        return null;
    }

    // check all providers for this
    for (const provider of providers) {
        if (provider.domainTest && provider.domainTest.test(url)) {
            return { url, provider };
        }
    }

    return null;
}

/**
 * Generates a placeholder to show while fetching preview content;
 * Generated placeholder is also used as the final container for the fetched content
 */
function generatePlaceholder() {
    // TODO make this look nice
    const placeholder = document.createElement("div");

    // give this a targetable class for external use / e2e testing
    placeholder.className = "js-placeholder";

    // everything inside the placeholder will be replaced on render
    placeholder.innerHTML = `<div class="s-spinner s-spinner__xs"></div>`;
    return placeholder;
}

/**
 * Gets nodes in the document that are able to be resolved by a preview provider
 * @param doc The document to search through
 * @param providers The list of registered providers
 */
function getValidNodes(doc: ProsemirrorNode, providers: LinkPreviewProvider[]) {
    const validNodes: {
        provider: { url: string; provider: LinkPreviewProvider };
        pos: number;
        node: ProsemirrorNode;
    }[] = [];

    // iterate over document structure
    doc.descendants((node, pos) => {
        const provider = getValidProvider(providers, node);

        if (provider) {
            validNodes.push({ provider, pos, node });

            // no need to go into this node's descendants
            return false;
        }
    });

    return validNodes;
}

/**
 * TODO: fire a transaction to update the view after the placeholder is insert
 *
 * Run over the entire document and find all previewable links and create a link preview decoration
 * for each.
 * @param {Document} doc - The document to find previewable link candidates in
 */
function generatePreviewDecorations(
    doc: ProsemirrorNode,
    providers: LinkPreviewProvider[]
) {
    const linkPreviewDecorations: Decoration[] = [];

    const nodes = getValidNodes(doc, providers);

    nodes.forEach((n) => {
        const placeholder = generatePlaceholder();
        linkPreviewDecorations.push(Decoration.widget(n.pos, placeholder));

        // if the url is in the cache, insert
        if (n.provider.url in previewResultCache) {
            insertLinkPreview(placeholder, previewResultCache[n.provider.url]);
        }
    });

    return DecorationSet.create(doc, linkPreviewDecorations);
}

/**
 * Inserts the link preview's content into the link's decoration/placeholder
 * @param placeholder The placeholder originally created to house this content
 * @param content The content returned from the link preview to insert
 */
function insertLinkPreview(placeholder: Element, content: Node | null) {
    // empty the placeholder content to remove the spinner / old content
    placeholder.innerHTML = "";

    // nothing to append, just return empty
    if (!content) {
        return;
    }

    placeholder.appendChild(content);
}

/**
 * Figure out if a given node in the document is a candidate for a link preview.
 * This will find all paragraphs that consist only of a link and nothing else.
 *
 * @param {Node} node - The node that should be checked
 */
function isPreviewableLink(node: ProsemirrorNode) {
    const child = node.content.firstChild;
    if (!child) return false;

    const hasOnlyOneChild = node.childCount === 1;
    const childIsTextNode = child.type.name === "text";
    const childHasLinkMark = child.marks.some(
        (mark) => mark.type.name === "link"
    );

    return hasOnlyOneChild && childIsTextNode && childHasLinkMark;
}

/**
 * Fetches and caches all link preview content for every link node in the view
 * @param view The view to search for valid link nodes
 * @param providers The list of registered providers
 */
function fetchLinkPreviewContent(
    view: EditorView,
    providers: LinkPreviewProvider[]
): Promise<Node[]> {
    // TODO can we make this more efficient?
    // getValidNodes will run on every state update, so it'd be
    // nice to be able to check the last transaction / updated doc
    // instead of the current snapshot

    const nodes = getValidNodes(view.state.doc, providers);

    // filter out all urls that are already in cache
    const unfetchedNodes = nodes.filter(
        (n) => !(n.provider.url in previewResultCache)
    );

    // if there's no data to fetch, just reject (no need to update the state)
    if (!unfetchedNodes.length) {
        return Promise.reject(null);
    }

    // start fetching all content
    const promises = unfetchedNodes.map((n) => {
        return (
            n.provider.provider
                .renderer(n.provider.url)
                .then((content) => {
                    // cache results so we don't call over and over...
                    previewResultCache[n.provider.url] = content;

                    return content;
                })
                // don't let any errors crash our `.all` below
                // "catch" and fake a resolution
                .catch(() => {
                    // TODO make this look nice
                    const errorPlaceholder = document.createElement("div");
                    errorPlaceholder.innerText = "Error fetching content.";
                    // set the cache here too, so we don't refetch errors every time...
                    previewResultCache[n.provider.url] = errorPlaceholder;
                    return Promise.resolve(errorPlaceholder);
                })
        );
    });

    return Promise.all(promises);
}

const LINK_PREVIEWS_KEY = new AsyncPluginKey<DecorationSet, Node[]>(
    "linkPreviews"
);

/**
 * Creates a plugin that searches the entire document for potentially previewable links
 * and creates a widget decoration to render the link preview in.
 */
export function linkPreviewPlugin(
    providers: LinkPreviewProvider[]
): AsyncPlugin<DecorationSet, Node[]> {
    providers = providers || [];

    return new AsyncPlugin<DecorationSet, Node[]>({
        key: LINK_PREVIEWS_KEY,
        asyncCallback: (view) => {
            return fetchLinkPreviewContent(view, providers);
        },
        state: {
            init(_, { doc }) {
                return generatePreviewDecorations(doc, providers);
            },
            apply(tr, value) {
                // only update the decorations if they changed at all
                if (this.getCallbackData(tr)) {
                    return generatePreviewDecorations(tr.doc, providers);
                }

                // else update the mappings to their new positions in the doc
                return value.map(tr.mapping, tr.doc);
            },
        },
        props: {
            decorations(state) {
                return this.getState(state);
            },
        },
    });
}
